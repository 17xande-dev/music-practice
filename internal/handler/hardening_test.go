package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/17xande-dev/music-practice/internal/auth"
	"github.com/17xande-dev/music-practice/internal/middleware"
	"github.com/17xande-dev/websec/webtest"
)

// The rules are websec's and tested there; this keeps one row per class at
// this call site: a hostile value (a browser drops the tab, so "/\t/evil" is
// "//evil"), legitimate relative targets (the auth redirect itself builds
// "next" from r.URL.Path alone, so a query and a fragment are not something it
// produces: those rows only show they are kept), and the deltas from the old
// local copy (dot segments, inner "//", trailing space now refused).
func TestSafeNext(t *testing.T) {
	for next, want := range map[string]string{
		"/progress":         "/progress",
		"/songs?x=1#y":      "/songs?x=1#y",
		"/":                 "/",
		"":                  "",
		"/\t/evil.example":  "",
		"/%09/evil.example": "",
		"//evil":            "",
		"https://evil":      "",
		"/a/../b":           "",
		"/a//b":             "",
		"/a ":               "",
		"/..%2f..%2fetc":    "/..%2f..%2fetc",
	} {
		if got := safeNext(next); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", next, got, want)
		}
	}
}

func TestSignInRedirectRefusesControlCharacters(t *testing.T) {
	// The five values this test always had, then every hostile spelling the kit
	// knows. The raw Location is checked: a Go http.Client would refuse to parse
	// "/\t/evil.example" and the test would pass on the transport error.
	for _, next := range append([]string{"/%09/evil.example", "/\t/evil", `/\\evil`, "https://evil", "//evil"}, webtest.HostileRedirects()...) {
		t.Run(fmt.Sprintf("%.30q", next), func(t *testing.T) {
			// A server per row: 22 sign-ins from one peer would meet the per-IP
			// limit (10) and answer 429 instead of the redirect under test.
			s := newTestServer(t)
			s.addUser(t, "a@x.com", false)
			s.client(t, "").PostForm("/account/login",
				url.Values{"email": {"a@x.com"}, "password": {testPassword}, "next": {next}}).
				WantRedirect(http.StatusSeeOther, "/account")
		})
	}
}

// The wiring, not the algorithm: a legitimate target with a query survives the
// sign-in POST. (The auth redirect builds "next" from r.URL.Path, so it never
// carries a query itself; this checks the POST does not strip one.)
func TestSignInRedirectKeepsLegitimateNext(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}, "next": {"/songs?x=1"}}, "")
	if loc := rec.Header.Get("Location"); loc != "/songs?x=1" {
		t.Errorf("redirected to %q", loc)
	}
}

// The login form's body is capped before it is read.
func TestFormBodiesAreCapped(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "admin@x.com", true)
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	adminCookie := s.signIn(t, "admin@x.com", testPassword)
	big := url.Values{"email": {"a@x.com"}, "password": {strings.Repeat("p", 5<<10)}}
	for _, tc := range []struct{ target, cookie string }{
		{"/account/login", ""},
		{"/account/logout", ""},
		{"/account/password", cookie},
		{"/account/sessions/1/revoke", cookie},
		{"/admin/users", adminCookie},
	} {
		body := big
		if strings.HasPrefix(tc.target, "/account/p") || strings.HasPrefix(tc.target, "/account/sessions") {
			body = url.Values{"current": {strings.Repeat("p", 9<<10)}}
		}
		if rec := s.do(t, "POST", tc.target, body, tc.cookie); rec.Status != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: status %d, want 413", tc.target, rec.Status)
		}
	}
	// A normal form is unaffected.
	if rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, ""); rec.Status != http.StatusSeeOther {
		t.Errorf("normal sign-in: %d", rec.Status)
	}
}

// Malformed emails are refused before the limiter, so junk cannot fill its map.
func TestBadEmailsSkipTheLimiter(t *testing.T) {
	s := newTestServer(t)
	for _, email := range []string{strings.Repeat("a", 250) + "@x.com", "not an email", "Alex <a@x.com>", ""} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {"whatever password"}}, "")
		if rec.Status != http.StatusBadRequest {
			t.Errorf("email %.20q: status %d, want 400", email, rec.Status)
		}
		rec = s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":%q,"password":"x","label":"l"}`, email), "", "")
		if rec.Status != http.StatusBadRequest {
			t.Errorf("token with email %.20q: status %d, want 400", email, rec.Status)
		}
	}
	s.h.limits.loginEmail.Allow("probe") // exercise the map under the lock
	if n := s.h.limits.loginEmail.Len(); n != 1 {
		t.Errorf("the email limiter holds %d buckets after bad emails, want only the probe", n)
	}
	if n := s.h.limits.loginIP.Len(); n != 0 {
		t.Errorf("the IP limiter holds %d buckets after bad emails", n)
	}
}

// Exercise the key at the limiter boundary: the form already normalises its
// input, so a route-only test cannot distinguish AccountKey from a raw key.
func TestEmailLimiterVariantsShareBucket(t *testing.T) {
	s := newTestServer(t)
	r := httptest.NewRequest("POST", "/account/login", nil)
	for _, email := range []string{"a@x.com", "A@X.com", " a@x.com ", "A@x.com", "  a@X.com "} {
		if !s.h.allowLogin(r, email) {
			t.Fatal("the limiter refused a request before the burst was spent")
		}
	}
	if s.h.allowLogin(r, " A@X.com ") {
		t.Error("changing case and whitespace bought an extra attempt")
	}
	if n := s.h.limits.loginEmail.Len(); n != 1 {
		t.Errorf("%d email buckets, want 1", n)
	}
}

// Every address in one IPv6 /64 shares the per-IP bucket.
func TestIPv6ClientsShareTheirSlash64(t *testing.T) {
	s := newTestServer(t)
	for i := range 10 {
		s.loginFrom(t, fmt.Sprintf("[2001:db8:1:2:%x::1]:4000", i+1), nil, fmt.Sprintf("u%d@x.com", i))
	}
	if code := s.loginFrom(t, "[2001:db8:1:2:ffff::9]:4000", nil, "another@x.com"); code != http.StatusTooManyRequests {
		t.Errorf("11th address in the /64: status %d, want 429", code)
	}
	// A different /64 is a different bucket.
	if code := s.loginFrom(t, "[2001:db8:1:3::9]:4000", nil, "another@x.com"); code == http.StatusTooManyRequests {
		t.Error("another /64 was limited")
	}
}

func TestSignInIsShedWhenPasswordQueueExpires(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	auth.ExpirePasswordQueueForTest(t)
	for _, email := range []string{"a@x.com", "unknown@x.com"} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {testPassword}}, "")
		if rec.Status != http.StatusServiceUnavailable || rec.Header.Get("Retry-After") != "5" {
			t.Errorf("form (%s): status %d, Retry-After %q", email, rec.Status, rec.Header.Get("Retry-After"))
		}
	}
	rec := s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":"a@x.com","password":%q}`, testPassword), "", "")
	if rec.Status != http.StatusServiceUnavailable || rec.Header.Get("Retry-After") != "5" ||
		!strings.HasPrefix(rec.Header.Get("Content-Type"), "application/json") || !strings.Contains(rec.Body, "busy") {
		t.Errorf("token: status %d, headers %v, body %s", rec.Status, rec.Header, rec.Body)
	}
}

func TestAdminPasswordResetIsShedWhenPasswordQueueExpires(t *testing.T) {
	s := newTestServer(t)
	admin := s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, admin.Email, testPassword)

	// The session cookie lets the request reach hashing without first
	// verifying a password, which would fail at the same queue deadline.
	auth.ExpirePasswordQueueForTest(t)
	rec := s.do(t, "POST", "/admin/users/"+itoa(u.ID)+"/reset", url.Values{}, cookie)
	if rec.Status != http.StatusServiceUnavailable || rec.Header.Get("Retry-After") != "5" {
		t.Fatalf("admin reset: status %d, Retry-After %q", rec.Status, rec.Header.Get("Retry-After"))
	}
}

func TestCanceledPasswordWaitIsNotBusy(t *testing.T) {
	s := newTestServer(t)
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	err := auth.SpendVerifyTime(canceled, testPassword)
	// A direct call of the error mapper, not a request: it stays on a recorder.
	rec := httptest.NewRecorder()
	s.h.serverError(rec, err)
	if rec.Code == http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "" {
		t.Errorf("cancellation: %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

// The submitted password and email never reach the log, in any common
// encoding; what the log does carry is the 12-hex email tag and the client IP.
// The email is longer than the old fixture because NoSecrets refuses secrets
// shorter than 12 bytes.
func TestFailedSignInsAndLimitsAreLoggedWithoutSecrets(t *testing.T) {
	s := newTestServer(t)
	log, logs := webtest.Logger(t)
	s.h.log = log
	const email, pw = "log.probe@example.test", "hunter2 hunter2 hunter2"
	s.addUser(t, email, false)
	for range 6 {
		s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {pw}}, "")
	}
	out := logs.String()
	webtest.NoSecrets(t, out, `"msg":"sign-in failed"`, pw, email)
	if !strings.Contains(out, `"msg":"sign-in rate limited"`) {
		t.Fatalf("missing the rate-limit log line:\n%s", out)
	}
	if !strings.Contains(out, `"email":"`+emailTag(email)+`"`) || !strings.Contains(out, `"ip":"192.0.2.1"`) {
		t.Errorf("log lacks the email hash prefix or the client IP:\n%s", out)
	}
	if !regexp.MustCompile(`"email":"[0-9a-f]{12}"`).MatchString(out) {
		t.Errorf("email is not a 12-hex tag:\n%s", out)
	}
}

// The JSON API is scanned as well as the form: a successful and a failed
// /api/token, a /api/sync with the bearer and a DELETE /api/token, through
// the handler's own log and the access log (Logging wraps the routes). The
// issued device token, the submitted password and the bearer header never
// reach either. The failed sign-in's own line is the required marker, so an
// empty log cannot pass.
func TestAPILogsCarryNoTokensOrPasswords(t *testing.T) {
	log, logs := webtest.Logger(t)
	s := newTestServerWith(t, func(o *Options) { o.Log = log })
	routes := middleware.Logging(log)(s.routes)
	const email, pw = "api.log.probe@example.test", testPassword
	s.addUser(t, email, false)
	c := func() *webtest.Client { return webtest.New(t, routes, csrfTestOrigin) }
	post := func(method, target, body, token string) *webtest.Response {
		t.Helper()
		cl := c()
		r := cl.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		return cl.Do(r)
	}
	creds := func(password string) string {
		return fmt.Sprintf(`{"email":%q,"password":%q,"label":"iPad"}`, email, password)
	}

	res := post("POST", "/api/token", creds(pw), "")
	res.WantStatus(http.StatusOK)
	var issued struct{ Token string }
	if err := json.Unmarshal([]byte(res.Body), &issued); err != nil || issued.Token == "" {
		t.Fatalf("no token issued: %v %s", err, res.Body)
	}
	const wrong = "wrong api probe password"
	post("POST", "/api/token", creds(wrong), "").WantStatus(http.StatusUnauthorized)
	post("POST", "/api/sync", `{"cursor":0}`, issued.Token).WantStatus(http.StatusOK)
	post("DELETE", "/api/token", "", issued.Token).WantStatus(http.StatusNoContent)
	// The token is revoked now; a replay is refused and logged too.
	post("POST", "/api/sync", `{"cursor":0}`, issued.Token).WantStatus(http.StatusUnauthorized)

	webtest.NoSecrets(t, logs.String(), `"msg":"sign-in failed"`, issued.Token, pw, wrong, email, "Bearer "+issued.Token)
}

// Signing in over a live session ends that session, so it does not linger in
// someone's device list as a valid but unreachable sign-in.
func TestSignInRevokesTheSessionItReplaces(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	s.addUser(t, "b@x.com", false)
	old := s.signIn(t, "a@x.com", testPassword)
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {"b@x.com"}, "password": {testPassword}}, old)
	if rec.Status != http.StatusSeeOther {
		t.Fatalf("second sign-in: %d", rec.Status)
	}
	if _, _, err := s.accounts.Authenticate(t.Context(), old); err == nil {
		t.Error("the replaced session still authenticates")
	}
	// A failed sign-in keeps the existing session.
	cur := s.signIn(t, "b@x.com", testPassword)
	s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {"wrong password!!"}}, cur)
	if _, _, err := s.accounts.Authenticate(t.Context(), cur); err != nil {
		t.Errorf("a failed sign-in ended the live session: %v", err)
	}
}

// The signed-out page carries the script that clears this browser's sync
// state; an ordinary sign-in page does not.
func TestSignedOutPageClearsLocalSync(t *testing.T) {
	s := newTestServer(t)
	body := s.do(t, "GET", "/account?notice=signed-out", nil, "").Body
	m := regexp.MustCompile(`<script type="module" src="(/static/dist/signout\.js\?v=[0-9a-f]+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("signed-out page lacks signout.js:\n%s", body)
	}
	if !strings.Contains(body, "You are signed out.") {
		t.Error("signed-out notice missing")
	}
	if rec := get(t, s.routes, m[1]); rec.Status != 200 || len(rec.Body) == 0 {
		t.Errorf("signout.js: %d, %d bytes", rec.Status, len(rec.Body))
	}
	if body := s.do(t, "GET", "/account", nil, "").Body; strings.Contains(body, "signout.js") {
		t.Error("the plain sign-in page clears sync state")
	}
	// Logging out and revoking this browser's own session both land on it.
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	rec := s.do(t, "POST", "/account/logout", url.Values{}, cookie)
	if loc := rec.Header.Get("Location"); loc != "/account?notice=signed-out" {
		t.Errorf("logout redirects to %q", loc)
	}
}

// A client the IP limiter refuses must not leave an email bucket per request:
// the email limiter is only consulted once the IP check has passed.
func TestRefusedIPLeavesNoEmailBuckets(t *testing.T) {
	s := newTestServer(t)
	for i := range 40 {
		email := fmt.Sprintf("u%d@x.com", i)
		s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {"wrong password!"}}, "")
		s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":%q,"password":"x","label":"l"}`, email), "", "")
	}
	// The IP burst is 10 sign-ins, so at most that many emails got a bucket.
	if n := s.h.limits.loginEmail.Len(); n > 10 {
		t.Errorf("the email limiter holds %d buckets after an IP-limited spray, want at most 10", n)
	}
}

// A sign-in whose password check passed, then overlapped a password reset
// (which deletes sessions), must not end up holding a session.
func TestSignInDoesNotOutliveAPasswordReset(t *testing.T) {
	for _, via := range []string{"web", "token"} {
		t.Run(via, func(t *testing.T) {
			s := newTestServer(t)
			u := s.addUser(t, "a@x.com", false)
			hash, err := auth.HashPassword(t.Context(), "a brand new password")
			if err != nil {
				t.Fatal(err)
			}
			s.h.afterVerify = func() {
				if err := s.accounts.SetPassword(t.Context(), u.ID, hash, 0); err != nil {
					t.Error(err)
				}
			}
			var code int
			if via == "web" {
				code = s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, "").Status
			} else {
				code = s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":"a@x.com","password":%q,"label":"l"}`, testPassword), "", "").Status
			}
			if code != http.StatusUnauthorized {
				t.Errorf("sign-in over a reset: %d, want 401", code)
			}
			var n int
			if err := s.db.QueryRow(`SELECT count(*) FROM auth_sessions WHERE user_id = ?`, u.ID).Scan(&n); err != nil || n != 0 {
				t.Errorf("%d sessions after the racing sign-in (err %v), want 0", n, err)
			}
		})
	}
}
