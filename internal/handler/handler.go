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
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"time"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/music-practice/internal/middleware"
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

	// ClientIP returns the visitor's address for rate limiting; nil means
	// the connection's own address.
	ClientIP func(*http.Request) string
}

// Handler renders pages and serves assets.
type Handler struct {
	log      *slog.Logger
	dev      bool
	tmplFS   fs.FS
	assets   *Assets
	pages    map[string]*template.Template
	accounts *account.Store
	clientIP func(*http.Request) string
	limits   limits
}

// limits are the rate limits on everything that verifies a password. Each
// verify costs ~100ms and 64 MiB, so an unmetered one is both a guessing
// oracle and a memory lever.
type limits struct {
	// loginEmail is tight: five tries, then one a minute, per email.
	loginEmail *middleware.Limiter
	// loginIP is looser, so one address cannot spray many emails.
	loginIP *middleware.Limiter
	// password limits the change-password form per account. It is keyed on
	// the user, not the cookie, which an attacker could simply discard.
	password *middleware.Limiter
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
	"dist/theme.js",
}

// New builds the handler, parsing every template up front so a template
// error is a startup failure.
func New(o Options) (*Handler, error) {
	if o.Accounts == nil {
		return nil, fmt.Errorf("handler: no account store")
	}
	h := &Handler{
		log: o.Log, dev: o.Dev, accounts: o.Accounts, clientIP: o.ClientIP,
		limits: limits{
			loginEmail: middleware.NewLimiter(5, time.Minute),
			loginIP:    middleware.NewLimiter(30, 10*time.Second),
			password:   middleware.NewLimiter(5, time.Minute),
		},
	}
	if h.clientIP == nil {
		h.clientIP = middleware.ClientIP("")
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

// Routes returns the mux. Every route is registered here, so this function
// is the complete list of what the server answers.
//
// Every state-changing request passes the stdlib's cross-origin check
// (Sec-Fetch-Site, falling back to Origin against Host), which is the CSRF
// defence for the forms and the API alike. A request from the iPad app
// carries neither header and passes; it authenticates with a bearer token a
// browser would never attach on its own.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	h.register(mux)
	h.registerAdmin(func(pattern string, f http.HandlerFunc) { mux.HandleFunc(pattern, f) })
	return adminHeaders(http.NewCrossOriginProtection().Handler(mux))
}

func (h *Handler) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", h.page("practice.html", "Scales"))
	mux.HandleFunc("GET /songs", h.page("songs.html", "Songs"))
	mux.HandleFunc("GET /progress", h.page("progress.html", "Progress"))
	mux.HandleFunc("GET /about", h.page("about.html", "About"))
	mux.Handle("GET /static/", h.assets)
	mux.HandleFunc("GET /sw.js", h.assets.ServiceWorker)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("ok\n"))
	})

	mux.HandleFunc("GET /account", h.accountGet)
	mux.HandleFunc("POST /account/login", h.login)
	mux.HandleFunc("POST /account/logout", h.logout)
	mux.HandleFunc("POST /account/password", h.requireUser(h.changePassword))
	mux.HandleFunc("POST /account/sessions/{id}/revoke", h.requireUser(h.revokeSession))
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
	h.log.Error("render", "err", err)
	http.Error(w, "internal server error", http.StatusInternalServerError)
}
