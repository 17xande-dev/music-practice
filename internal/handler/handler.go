// Package handler is the HTTP surface: page rendering, static assets, and
// the account pages.
//
// The practice pages are shells, identical for every visitor: MIDI input,
// grading and progress all happen in the Deno-bundled TypeScript, and
// progress lives in the browser's localStorage. Accounts (stage 2) add the
// /account pages and sync history through the server.
package handler

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/music-practice/internal/history"

	"github.com/17xande-dev/password"
	"github.com/17xande-dev/ratelimit"
	"github.com/17xande-dev/ratelimit/clientip"
	"github.com/17xande-dev/websec/cookie"
	"golang.org/x/time/rate"
)

//go:embed templates
var templatesFS embed.FS

//go:embed all:static
var staticFS embed.FS

// Source directories read in dev mode, relative to the repository root
// (where `make dev` runs the server).
const (
	devTemplatesDir = "internal/handler/templates"
	devStaticDir    = "internal/handler/static"
)

// Options configures a Handler.
type Options struct {
	Log *slog.Logger

	// Dev reads templates and static files from the source tree on every
	// request instead of the copies embedded at compile time, so an edited
	// template or a rebundled script shows on refresh.
	Dev bool

	// Accounts is the users and sessions store.
	Accounts *account.Store

	// History is the synced practice runs.
	History *history.Store

	// CookieSecure is set by the deployment, even when the app sees plain HTTP
	// behind a TLS-terminating proxy.
	CookieSecure bool

	// BaseURL is the validated public origin, if configured.
	BaseURL string

	// ClientIP resolves the visitor's address for rate limiting; the zero
	// value uses the connection's own address.
	ClientIP clientip.Source
}

// Handler renders pages and serves assets.
type Handler struct {
	log      *slog.Logger
	dev      bool
	tmplFS   fs.FS
	assets   *Assets
	pages    map[string]*template.Template
	accounts *account.Store
	history  *history.Store
	clientIP clientip.Source
	limits   limits

	session *cookie.Cookie
	router  http.Handler

	// afterVerify, when set, runs between a sign-in's password check and its
	// session insert; tests use it to land a password reset in that window.
	afterVerify func()
}

// limits are the rate limits on everything that verifies a password. Each
// verify costs ~100ms and 64 MiB, so an unmetered one is both a guessing
// oracle and a memory lever.
type limits struct {
	// loginEmail is tight: five tries, then one a minute, per email.
	loginEmail *ratelimit.Limiter
	// loginIP is looser, so one address cannot spray many emails.
	loginIP *ratelimit.Limiter
	// password limits the change-password form per account. It is keyed on
	// the user, not the cookie, which an attacker could simply discard.
	password *ratelimit.Limiter
}

// newLimits builds the three limiters, all failing closed when full. A bucket
// is dropped once idle for burst*interval, as before.
func newLimits() (limits, error) {
	mk := func(burst int, interval time.Duration) (*ratelimit.Limiter, error) {
		return ratelimit.New(ratelimit.Config{
			Rate: rate.Every(interval), Burst: burst, IdleTTL: time.Duration(burst) * interval,
		})
	}
	var l limits
	var err error
	if l.loginEmail, err = mk(5, time.Minute); err != nil {
		return limits{}, err
	}
	if l.loginIP, err = mk(10, 10*time.Second); err != nil {
		return limits{}, err
	}
	if l.password, err = mk(5, time.Minute); err != nil {
		return limits{}, err
	}
	return l, nil
}

// ipAddr is the visitor's address as the logs show it ("unknown" when the
// connection's own address does not parse).
func (h *Handler) ipAddr(r *http.Request) string {
	if a := h.clientIP.Addr(r); a.IsValid() {
		return a.WithZone("").Unmap().String()
	}
	return "unknown"
}

// ipKey is the loginIP bucket key for r: one per IPv4 address, one per IPv6 /64.
func (h *Handler) ipKey(r *http.Request) string {
	return ratelimit.IPKey(h.clientIP.Addr(r))
}

// pageFiles are the page templates, each parsed into its own set with the
// layout. One set per page, because every page defines "content": in a single
// flat set the last file parsed would silently win and pages would render as
// each other.
var pageFiles = []string{"practice.html", "songs.html", "progress.html", "about.html", "account.html",
	"admin_users.html", "admin_password.html", "admin_delete.html"}

// Bundles are the Deno outputs the pages load. Checked at boot so a binary
// built without `make bundle` refuses to start instead of serving dead pages.
var Bundles = []string{
	"dist/practice.js", "dist/songs.js", "dist/progress.js", "dist/pitch_worklet.js", "dist/sw.js",
	"dist/theme.js", "dist/signout.js",
}

// New builds the handler, parsing every template up front so a template
// error is a startup failure.
func New(o Options) (*Handler, error) {
	if o.Accounts == nil || o.History == nil {
		return nil, fmt.Errorf("handler: no account or history store")
	}
	lims, err := newLimits()
	if err != nil {
		return nil, err
	}
	session, err := cookie.New(cookie.Config{Name: sessionCookie, Insecure: !o.CookieSecure, Now: o.Accounts.Now})
	if err != nil {
		return nil, fmt.Errorf("session cookie: %w", err)
	}
	h := &Handler{
		log: o.Log, dev: o.Dev, accounts: o.Accounts, history: o.History, clientIP: o.ClientIP,
		session: session, limits: lims,
	}
	if h.log == nil {
		h.log = slog.Default()
	}
	if o.Dev {
		h.tmplFS = os.DirFS(devTemplatesDir)
		h.assets = NewAssets(os.DirFS(devStaticDir), true)
	} else {
		h.tmplFS, _ = fs.Sub(templatesFS, "templates")
		sub, _ := fs.Sub(staticFS, "static")
		h.assets = NewAssets(sub, false)
	}
	if err := h.assets.Check(append([]string{"styles.css"}, Bundles...)...); err != nil {
		return nil, err
	}
	pages, err := h.parsePages()
	if err != nil {
		return nil, err
	}
	h.pages = pages
	h.router, err = h.newRoutes(o.BaseURL)
	if err != nil {
		return nil, err
	}
	return h, nil
}

func (h *Handler) parsePages() (map[string]*template.Template, error) {
	funcs := template.FuncMap{
		"asset": h.assets.URL,
		"icon":  icon,
		// Arguments for the sun/moon switch template.
		"switch": func(id, label string) map[string]string { return map[string]string{"ID": id, "Label": label} },
		"when":   when,
	}
	pages := map[string]*template.Template{}
	for _, name := range pageFiles {
		t, err := template.New(name).Funcs(funcs).ParseFS(h.tmplFS, "layout.html", name)
		if err != nil {
			return nil, fmt.Errorf("handler: parse %s: %w", name, err)
		}
		if t.Lookup("content") == nil {
			return nil, fmt.Errorf("handler: %s defines no \"content\" template", name)
		}
		pages[name] = t
	}
	return pages, nil
}

// Routes returns the complete HTTP router, including cross-origin protection.
func (h *Handler) Routes() http.Handler { return h.router }

func (h *Handler) newRoutes(origin string) (http.Handler, error) {
	mux := http.NewServeMux()
	patterns := make(map[string]bool)
	h.routes(func(pattern string, f http.Handler) {
		mux.Handle(pattern, f)
		patterns[pattern] = true
	})
	protection := http.NewCrossOriginProtection()
	if origin != "" {
		if err := protection.AddTrustedOrigin(origin); err != nil {
			return nil, fmt.Errorf("csrf: add trusted origin: %w", err)
		}
	}
	protection.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Handler can return a concrete path for a redirect; only log registered patterns.
		_, pattern := mux.Handler(r)
		if !patterns[pattern] {
			pattern = "(unmatched)"
		}
		reason := "Origin"
		if r.Header.Get("Sec-Fetch-Site") != "" {
			reason = "Sec-Fetch-Site"
		}
		h.log.WarnContext(r.Context(), "csrf: request refused", "method", r.Method, "route", pattern, "reason", reason)
		w.Header().Set("Cache-Control", "no-store")
		const message = "cross-origin request refused"
		if strings.HasPrefix(r.URL.Path, "/api/") {
			apiError(w, http.StatusForbidden, message)
			return
		}
		http.Error(w, message, http.StatusForbidden)
	}))
	// Wrap the whole mux, not just cookie routes: desktop forms and native sync
	// share the same origin policy. No headers is a supported native request.
	return adminHeaders(protection.Handler(mux)), nil
}

// handleFunc registers one route. Every route goes through one, so a test
// can collect the complete list (see TestEveryRouteIsPublicOrProtected)
// instead of trusting a second, hand-kept list to stay in step.
type handleFunc func(pattern string, f http.Handler)

func (h *Handler) routes(handle handleFunc) {
	h.register(handle)
	h.registerAPI(handle)
	h.registerAdmin(handle)
}

func (h *Handler) register(handle handleFunc) {
	handle("GET /{$}", h.page("practice.html", "Scales"))
	handle("GET /songs", h.page("songs.html", "Songs"))
	handle("GET /progress", h.page("progress.html", "Progress"))
	handle("GET /about", h.page("about.html", "About"))
	handle("GET /static/", h.assets)
	handle("GET /sw.js", http.HandlerFunc(h.assets.ServiceWorker))
	handle("GET /healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("ok\n"))
	}))

	handle("GET /account", http.HandlerFunc(h.accountGet))
	handle("POST /account/login", http.HandlerFunc(h.login))
	handle("POST /account/logout", http.HandlerFunc(h.logout))
	handle("POST /account/password", h.requireUser(h.changePassword))
	handle("POST /account/sessions/{id}/revoke", h.requireUser(h.revokeSession))
}

// pageData is what every page template receives.
type pageData struct {
	Title string
	// Nav is the page's own filename stem, for marking the current nav link.
	Nav string
	// Data is what a page needs beyond the layout (the account pages).
	Data any
}

func (h *Handler) page(file, title string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.render(w, http.StatusOK, file, title, nil)
	}
}

// render writes one page. Pages carrying data are someone's account, so
// they are no-store; the empty shells only need revalidating.
func (h *Handler) render(w http.ResponseWriter, status int, file, title string, data any) {
	pages := h.pages
	if h.dev {
		p, err := h.parsePages()
		if err != nil {
			h.serverError(w, err)
			return
		}
		pages = p
	}
	nav := file[:len(file)-len(path.Ext(file))]
	// Render into a buffer so a template error can still be a clean 500
	// rather than half a page under a 200.
	var buf bytes.Buffer
	if err := pages[file].ExecuteTemplate(&buf, "layout", pageData{Title: title, Nav: nav, Data: data}); err != nil {
		h.serverError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if data != nil {
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.WriteHeader(status)
	buf.WriteTo(w)
}

func (h *Handler) serverError(w http.ResponseWriter, err error) {
	if passwordBusy(err) {
		busy(w)
		return
	}
	h.log.Error("render", "err", err)
	http.Error(w, "internal server error", http.StatusInternalServerError)
}

func passwordBusy(err error) bool {
	// The module also reports ErrBusy when a client cancels the request.
	return errors.Is(err, password.ErrBusy) && errors.Is(err, context.DeadlineExceeded)
}

// busy answers a request that could not get an argon2 slot: 503 with a
// Retry-After, which is a fault of load, not of the request.
func busy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	http.Error(w, "the server is busy; try again in a few seconds", http.StatusServiceUnavailable)
}

// Form bodies are capped before they are read: sign-in and the admin forms
// carry a couple of short fields, the password form three of at most 256
// characters (up to three bytes each once percent-escaped).
const (
	maxFormBody     = 4 << 10
	maxPasswordForm = 8 << 10
)

// parseForm reads a POSTed form under a size cap. It answers 413 itself and
// reports false when the body is over the cap or unreadable.
func parseForm(w http.ResponseWriter, r *http.Request, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseForm(); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "form too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "bad form", http.StatusBadRequest)
		}
		return false
	}
	return true
}
