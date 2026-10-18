package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/music-practice/internal/auth"
	"github.com/17xande-dev/music-practice/internal/middleware"
)

// sessionCookie carries a browser's session token.
const sessionCookie = "mp_session"

// notices and accountErrors are the only messages a redirect can ask the
// account page to show. The query carries a code, never text, so a crafted
// link cannot put words on the page.
var notices = map[string]string{
	"signed-out":       "You are signed out.",
	"password-changed": "Your password is changed. Your other devices have been signed out.",
	"revoked":          "That device is signed out.",
}

var accountErrors = map[string]string{
	"wrong-password":    "The current password is not right.",
	"password-mismatch": "The new passwords do not match.",
	"password-short":    auth.ErrPasswordTooShort.Error() + ".",
	"password-long":     auth.ErrPasswordTooLong.Error() + ".",
	"rate-limited":      "Too many attempts. Wait a minute and try again.",
}

// loginFailed is the one message for every failed sign-in: an unknown email,
// a wrong password and a disabled account must be indistinguishable, or the
// form tells anyone which emails have accounts.
const loginFailed = "That email and password do not match an account."

// accountView is the account page's data: exactly one half is set.
type accountView struct {
	SignIn *loginPage
	Signed *accountPage
}

type loginPage struct {
	Email, Next, Error, Notice string
	// ClearSync loads the script that turns this browser's sync off.
	ClearSync bool
}

type accountPage struct {
	User      account.User
	Sessions  []account.Session
	CurrentID int64
	Notice    string
	Error     string
}

// currentUser resolves the request's session cookie. Only the account,
// admin and API routes call it: the page shells stay identical for everyone,
// which is what lets the service worker cache them.
func (h *Handler) currentUser(r *http.Request) (account.User, account.Session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return account.User{}, account.Session{}, false
	}
	u, s, err := h.accounts.Authenticate(r.Context(), c.Value)
	if err != nil {
		if !errors.Is(err, account.ErrNotFound) {
			h.log.Error("authenticate", "err", err)
		}
		return account.User{}, account.Session{}, false
	}
	return u, s, true
}

// secureCookie reports whether the session cookie gets the Secure flag. A
// browser drops a Secure cookie set over plain HTTP (except from localhost),
// so web sign-in on a LAN address needs it off, but only where that is
// honestly plain HTTP: auto drops Secure only when the request has no TLS,
// no proxy says it was https, and HSTS (the operator's "this site is https")
// is off. X-Forwarded-Proto can only ever raise this to Secure, never lower
// it, so a forged header gains an attacker nothing.
func (h *Handler) secureCookie(r *http.Request) bool {
	switch h.cookieSecure {
	case "1":
		return true
	case "0":
		return false
	}
	if h.hsts || r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (h *Handler) setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.secureCookie(r),
		// Lax, hard-coded: the cookie signs in an account (and an admin), so it
		// must never ride along on another site's cross-site POST.
		SameSite: http.SameSiteLaxMode,
		// The browser's maximum. The server's own expiry (90 days, sliding)
		// decides when the session ends; the cookie only has to outlive it.
		MaxAge: 400 * 24 * 60 * 60,
	})
}

func (h *Handler) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true,
		Secure: h.secureCookie(r), SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

// safeNext keeps a post-sign-in redirect on this site: a path starting with
// exactly one "/", with no scheme, host or control characters. Browsers strip
// tabs and newlines from a URL and read a backslash as a slash, so "/\tevil",
// "/%09/evil.example" and "/\\evil" would all send the visitor to another
// host. Anything doubtful is dropped (the redirect goes to /account).
func safeNext(next string) string {
	if next == "" || len(next) > 2048 || next[0] != '/' || strings.HasPrefix(next, "//") {
		return ""
	}
	bad := func(s string) bool {
		return strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f || r == '\\' })
	}
	if bad(next) {
		return ""
	}
	u, err := url.Parse(next)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil || u.Opaque != "" {
		return ""
	}
	// The decoded path must hold the same line: "/%09/evil.example" decodes
	// to "/<tab>/evil.example", and a proxy or a later decode might act on it.
	if bad(u.Path) || !strings.HasPrefix(u.Path, "/") || strings.HasPrefix(u.Path, "//") {
		return ""
	}
	return next
}

func (h *Handler) accountGet(w http.ResponseWriter, r *http.Request) {
	u, sess, ok := h.currentUser(r)
	if !ok {
		q := r.URL.Query()
		// Signing out lands here, signed out. This is where the browser also
		// forgets its local sync state (see static/dist/signout.js), so the
		// next person to use it cannot push their history into this account.
		h.render(w, http.StatusOK, "account.html", "Sign in", accountView{SignIn: &loginPage{
			Next: safeNext(q.Get("next")), Notice: notices[q.Get("notice")], ClearSync: q.Get("notice") == "signed-out",
		}})
		return
	}
	sessions, err := h.accounts.Sessions(r.Context(), u.ID)
	if err != nil {
		h.serverError(w, err)
		return
	}
	q := r.URL.Query()
	h.render(w, http.StatusOK, "account.html", "Account", accountView{Signed: &accountPage{
		User: u, Sessions: sessions, CurrentID: sess.ID,
		Notice: notices[q.Get("notice")], Error: accountErrors[q.Get("error")],
	}})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r, maxFormBody) {
		return
	}
	rawEmail := strings.TrimSpace(r.PostForm.Get("email"))
	password := r.PostForm.Get("password")
	next := safeNext(r.PostForm.Get("next"))
	fail := func(status int, msg string) {
		h.render(w, status, "account.html", "Sign in", accountView{SignIn: &loginPage{Email: rawEmail, Next: next, Error: msg}})
	}
	// A malformed email never reaches the limiter, so junk cannot fill its map
	// or cost an argon2 verify.
	email, err := account.NormalizeEmail(rawEmail)
	if err != nil {
		fail(http.StatusBadRequest, "That is not a valid email address.")
		return
	}
	if !h.allowLogin(r, email) {
		fail(http.StatusTooManyRequests, accountErrors["rate-limited"])
		return
	}
	u, err := h.checkPassword(r, email, password)
	if err != nil {
		if errors.Is(err, errBadCredentials) {
			fail(http.StatusUnauthorized, loginFailed)
		} else {
			h.serverError(w, err)
		}
		return
	}
	token, _, err := h.accounts.CreateSession(r.Context(), u.ID, account.KindWeb, browserLabel(r.UserAgent()))
	if err != nil {
		h.serverError(w, err)
		return
	}
	// Signing in over a live session (another account's, say) ends the old
	// one: otherwise it lingers, valid but unreachable, in that account's
	// device list.
	if old, err := r.Cookie(sessionCookie); err == nil && old.Value != token {
		if err := h.accounts.RevokeToken(r.Context(), old.Value); err != nil {
			h.log.Error("revoke previous session", "err", err)
		}
	}
	h.accounts.RecordLogin(r.Context(), u.ID)
	h.setSessionCookie(w, r, token)
	if next == "" {
		next = "/account"
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}

var errBadCredentials = errors.New("bad credentials")

// emailTag identifies an email in the logs without recording it: the first
// bytes of its sha256, enough to correlate attempts on one address.
func emailTag(email string) string {
	sum := sha256.Sum256([]byte(email))
	return hex.EncodeToString(sum[:])[:12]
}

// allowLogin applies both sign-in limits to an already normalised email. The
// tight one is keyed on the email's hash, which an attacker cannot shed the
// way they can a cookie; the looser per-IP ceiling (an IPv6 client counts by
// its /64) stops one address spraying many emails. A refusal is logged.
func (h *Handler) allowLogin(r *http.Request, email string) bool {
	ip := h.clientIP(r)
	ipOK := h.limits.loginIP.Allow(middleware.IPKey(ip))
	sum := sha256.Sum256([]byte(email))
	emailOK := h.limits.loginEmail.Allow(string(sum[:]))
	if !ipOK || !emailOK {
		h.log.Warn("sign-in rate limited", "email", emailTag(email), "ip", ip, "path", r.URL.Path,
			"by_ip", !ipOK, "by_email", !emailOK)
	}
	return ipOK && emailOK
}

// checkPassword is the one place a sign-in is decided, shared by the web
// form and the app's token endpoint. Every failure costs one argon2 verify
// and returns errBadCredentials, whatever the cause. email is normalised.
func (h *Handler) checkPassword(r *http.Request, email, password string) (account.User, error) {
	bad := func(why string) (account.User, error) {
		// Never the password or the email itself; the why is for the operator
		// only, the client sees one message.
		h.log.Warn("sign-in failed", "email", emailTag(email), "ip", h.clientIP(r), "path", r.URL.Path, "why", why)
		return account.User{}, errBadCredentials
	}
	u, err := h.accounts.ByEmail(r.Context(), email)
	if errors.Is(err, account.ErrNotFound) {
		if err := auth.SpendVerifyTime(password); err != nil {
			return account.User{}, err
		}
		return bad("unknown email")
	}
	if err != nil {
		return account.User{}, err
	}
	ok, err := auth.VerifyPassword(password, u.PasswordHash)
	if err != nil {
		return account.User{}, err
	}
	// Disabled is checked after the password, so a disabled account answers
	// exactly as a wrong password does.
	if !ok {
		return bad("wrong password")
	}
	if u.Disabled {
		return bad("disabled")
	}
	return u, nil
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r, maxFormBody) {
		return
	}
	if c, err := r.Cookie(sessionCookie); err == nil {
		if err := h.accounts.RevokeToken(r.Context(), c.Value); err != nil {
			h.serverError(w, err)
			return
		}
	}
	h.clearSessionCookie(w, r)
	http.Redirect(w, r, "/account?notice=signed-out", http.StatusSeeOther)
}

// requireUser wraps a POST that needs a signed-in user. Anyone else is sent
// to the sign-in page and nothing is done.
func (h *Handler) requireUser(next func(http.ResponseWriter, *http.Request, account.User, account.Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, s, ok := h.currentUser(r)
		if !ok {
			http.Redirect(w, r, "/account", http.StatusSeeOther)
			return
		}
		if r.Method == http.MethodPost && !parseForm(w, r, maxPasswordForm) {
			return
		}
		next(w, r, u, s)
	}
}

func (h *Handler) changePassword(w http.ResponseWriter, r *http.Request, u account.User, s account.Session) {
	back := func(code string) {
		http.Redirect(w, r, "/account?error="+code+"#password", http.StatusSeeOther)
	}
	// Limited like sign-in: a form that checks the current password is a
	// guessing oracle for anyone holding a stolen cookie.
	if !h.limits.loginIP.Allow(middleware.IPKey(h.clientIP(r))) || !h.limits.password.Allow(strconv.FormatInt(u.ID, 10)) {
		h.log.Warn("password change rate limited", "user", u.ID, "ip", h.clientIP(r))
		back("rate-limited")
		return
	}
	ok, err := auth.VerifyPassword(r.PostFormValue("current"), u.PasswordHash)
	if err != nil {
		h.serverError(w, err)
		return
	}
	if !ok {
		h.log.Warn("password change failed", "user", u.ID, "ip", h.clientIP(r))
		back("wrong-password")
		return
	}
	pw := r.PostFormValue("new")
	if pw != r.PostFormValue("confirm") {
		back("password-mismatch")
		return
	}
	switch auth.CheckPolicy(pw) {
	case auth.ErrPasswordTooShort:
		back("password-short")
		return
	case auth.ErrPasswordTooLong:
		back("password-long")
		return
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		h.serverError(w, err)
		return
	}
	if err := h.accounts.SetPassword(r.Context(), u.ID, hash, s.ID); err != nil {
		h.serverError(w, err)
		return
	}
	http.Redirect(w, r, "/account?notice=password-changed", http.StatusSeeOther)
}

func (h *Handler) revokeSession(w http.ResponseWriter, r *http.Request, u account.User, s account.Session) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad session id", http.StatusBadRequest)
		return
	}
	if err := h.accounts.Revoke(r.Context(), u.ID, id); err != nil {
		h.serverError(w, err)
		return
	}
	if id == s.ID {
		h.clearSessionCookie(w, r)
		http.Redirect(w, r, "/account?notice=signed-out", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/account?notice=revoked", http.StatusSeeOther)
}

// browserLabel names a web session in the device list ("Firefox on Linux"),
// from the user agent. A rough guess is enough to tell sessions apart.
func browserLabel(ua string) string {
	browser := "A browser"
	for _, b := range []struct{ token, name string }{
		{"Edg/", "Edge"}, {"Firefox/", "Firefox"}, {"Chrome/", "Chrome"}, {"Safari/", "Safari"},
	} {
		if strings.Contains(ua, b.token) {
			browser = b.name
			break
		}
	}
	for _, o := range []struct{ token, name string }{
		{"iPad", "iPad"}, {"iPhone", "iPhone"}, {"Android", "Android"}, {"Mac OS X", "macOS"},
		{"Windows", "Windows"}, {"Linux", "Linux"},
	} {
		if strings.Contains(ua, o.token) {
			return browser + " on " + o.name
		}
	}
	return browser
}

// when formats a stored time for the page, labelled UTC so nobody misreads
// it as their own timezone.
func when(t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	return t.UTC().Format("2 Jan 2006, 15:04 UTC")
}
