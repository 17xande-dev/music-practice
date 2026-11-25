package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/17xande-dev/music-practice/internal/middleware"
	"github.com/17xande-dev/websec/webtest"
)

const csrfTestOrigin = "https://practice.example"

func TestCrossOriginUnsafeRoutes(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "sweep@example.test", true)
	c := webtest.New(t, s.routes, csrfTestOrigin)
	c.PostForm("/account/login", url.Values{"email": {"sweep@example.test"}, "password": {testPassword}}).
		WantStatus(http.StatusSeeOther)
	cookieValue, ok := c.Cookie("__Host-mp_session")
	if !ok {
		t.Fatal("sign-in did not set a session cookie")
	}

	var unsafePatterns []string
	s.h.routes(func(pattern string, _ http.Handler) {
		method, _, _ := strings.Cut(pattern, " ")
		if method != http.MethodGet && method != http.MethodHead {
			unsafePatterns = append(unsafePatterns, pattern)
		}
	})
	routes := webtest.Routes(t, unsafePatterns, map[string]string{"id": "1"})
	for _, tc := range []struct {
		name string
		opts []webtest.Option
	}{
		{"fetch-metadata", []webtest.Option{webtest.NoOrigin(), webtest.SecFetchSite("cross-site")}},
		{"origin-only", []webtest.Option{webtest.WithOrigin("https://elsewhere.example")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := csrfTestState(t, s)
			webtest.Sweep{
				Routes: routes,
				Min:    15, // exactly the current unsafe routes: removing one must fail until this is lowered on purpose.
				Client: func() *webtest.Client {
					return webtest.New(t, s.routes, csrfTestOrigin, tc.opts...)
				},
				Cookies: []*http.Cookie{{Name: "__Host-mp_session", Value: cookieValue, Path: "/", Secure: true}},
				NoToken: true, // No per-form token in the stdlib policy.
				Refused: func(_ webtest.Route, r *webtest.Response) error {
					// A handler's own 403 (e.g. admin auth) isn't evidence of CSRF protection.
					if r.Status != http.StatusForbidden || r.Header.Get("Cache-Control") != "no-store" ||
						!strings.Contains(r.Body, "cross-origin request refused") {
						return fmt.Errorf("want the CSRF layer's no-store 403")
					}
					return nil
				},
			}.Run(t)
			if csrfTestState(t, s) != before {
				t.Error("cross-origin refusals changed database state")
			}
		})
	}
}

func csrfTestState(t *testing.T, s *testServer) [3]string {
	t.Helper()
	// Compare rows, not just counts: password resets and session touches
	// change data without adding or deleting rows.
	var state [3]string
	for i, query := range []string{
		`SELECT json_group_array(json_array(id,email,password_hash,is_admin,disabled,created_at,last_login_at) ORDER BY id) FROM users`,
		`SELECT json_group_array(json_array(id,token_hash,user_id,kind,label,created_at,last_used_at,expires_at) ORDER BY id) FROM auth_sessions`,
		`SELECT json_group_array(json_array(seq,user_id,kind,id,data) ORDER BY seq) FROM records`,
	} {
		if err := s.db.QueryRowContext(t.Context(), query).Scan(&state[i]); err != nil {
			t.Fatal(err)
		}
	}
	return state
}

func TestCrossOriginRefusalLog(t *testing.T) {
	log, logs := webtest.Logger(t)
	s := newTestServerWith(t, func(o *Options) { o.Log = log })
	c := webtest.New(t, middleware.Logging(log)(s.routes), csrfTestOrigin)
	const segment, query, bearer, cookie = "privateSegmentValue", "privateQueryValue", "privateBearerValue", "privateCookieValue"
	res := c.PostForm("/admin/users/"+segment+"/disable?hidden="+query, nil,
		webtest.SecFetchSite("cross-site"), webtest.NoOrigin(),
		webtest.Header("Authorization", "Bearer "+bearer), webtest.Header("Cookie", "__Host-mp_session="+cookie))
	res.WantStatus(http.StatusForbidden)
	// An unregistered request must log the fallback, not the path.
	c.PostForm("/account/"+segment, nil, webtest.WithOrigin("https://"+segment+".example")).
		WantStatus(http.StatusForbidden)
	// The API gets the same status and no-store policy in its own wire format.
	res = c.PostForm("/api/sync", nil, webtest.WithOrigin("https://"+segment+".example"))
	res.WantStatus(http.StatusForbidden)
	if res.Header.Get("Content-Type") != "application/json" || res.Header.Get("Cache-Control") != "no-store" ||
		strings.TrimSpace(res.Body) != `{"error":"cross-origin request refused"}` {
		t.Error("API refusal must be a non-cacheable JSON error")
	}
	text := logs.String()
	webtest.NoSecrets(t, text, `"msg":"cross-origin request refused"`, segment, query, bearer, cookie)
	want := [][2]string{
		{"POST /admin/users/{id}/disable", "Sec-Fetch-Site"},
		{"unmatched", "Origin"},
		{"POST /api/sync", "Origin"},
	}
	i := 0
	for line := range strings.SplitSeq(strings.TrimSpace(text), "\n") {
		var row struct{ Msg, Level, Method, Route, Header string }
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal("refusal log is not JSON")
		}
		if row.Msg != "cross-origin request refused" {
			continue
		}
		if i >= len(want) || row.Level != "WARN" || row.Method != "POST" ||
			row.Route != want[i][0] || row.Header != want[i][1] {
			t.Fatalf("unexpected refusal log fields at index %d", i)
		}
		i++
	}
	if i != len(want) {
		t.Fatalf("got %d refusal warnings, want %d", i, len(want))
	}
}

func TestTrustedOriginWithRewrittenHost(t *testing.T) {
	s := newTestServerWith(t, func(o *Options) { o.BaseURL = csrfTestOrigin })
	c := webtest.New(t, s.routes, "https://internal.example")
	s.addUser(t, "proxy@example.test", false)
	// Without Fetch Metadata the check needs the configured public origin.
	c.PostForm("/account/login", url.Values{"email": {"proxy@example.test"}, "password": {testPassword}},
		webtest.WithOrigin(csrfTestOrigin)).WantStatus(http.StatusSeeOther)
	c.Get("/api/me").WantStatus(http.StatusOK)
}

func TestWorksheetCookieSyncOriginPolicy(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "worksheet@example.test", false)
	c := webtest.New(t, s.routes, csrfTestOrigin)
	c.PostForm("/account/login", url.Values{"email": {"worksheet@example.test"}, "password": {testPassword}}).
		WantStatus(http.StatusSeeOther)
	for _, tc := range []struct {
		name string
		opts []webtest.Option
	}{
		{"same-origin-fetch", []webtest.Option{webtest.SecFetchSite("same-origin")}},
		{"same-origin-fallback", nil},
		{"no-headers", []webtest.Option{webtest.NoOrigin()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := c.With(t)
			res := csrfTestJSON(c, http.MethodPost, "/api/sync",
				`{"account":"worksheet@example.test","cursor":0}`, tc.opts...)
			res.WantStatus(http.StatusOK)
			if res.Header.Get("Cache-Control") != "no-store" {
				t.Error("sync response is cacheable")
			}
		})
	}
}

func TestNativeAPIWithoutOrigin(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "native@example.test", false)
	c := webtest.New(t, s.routes, csrfTestOrigin, webtest.NoOrigin())
	res := csrfTestJSON(c, http.MethodPost, "/api/token",
		`{"email":"native@example.test","password":"`+testPassword+`","label":"iPad"}`)
	// Do not include the returned token in an assertion failure.
	var credentials struct{ Token string }
	if res.Status != http.StatusOK || json.Unmarshal([]byte(res.Body), &credentials) != nil || credentials.Token == "" {
		t.Fatalf("native sign-in did not return a token (status %d)", res.Status)
	}
	auth := webtest.Header("Authorization", "bEaReR "+credentials.Token)
	c.Get("/api/me", auth).WantStatus(http.StatusOK)
	csrfTestJSON(c, http.MethodPost, "/api/sync", `{"cursor":0}`, auth).WantStatus(http.StatusOK)
	c.Do(c.NewRequest(http.MethodDelete, "/api/token", nil), auth).WantStatus(http.StatusNoContent)
	c.Get("/api/me", auth).WantStatus(http.StatusUnauthorized)
}

// A browser holding a valid cookie must not authenticate through an
// Authorization header that has the Bearer scheme but no token.
func TestEmptyBearerDoesNotFallBackToCookie(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "empty@example.test", false)
	c := webtest.New(t, s.routes, csrfTestOrigin)
	c.PostForm("/account/login", url.Values{"email": {"empty@example.test"}, "password": {testPassword}}).
		WantStatus(http.StatusSeeOther)
	c.Get("/api/me").WantStatus(http.StatusOK) // the cookie itself is valid
	// Any Authorization header that is not one well-formed Bearer token is a
	// credential the request supplied and we cannot use: 401, never the cookie.
	for name, headers := range map[string][]string{
		"bare scheme":        {"Bearer"},
		"trailing space":     {"Bearer "},
		"mixed case":         {"bearer  "},
		"trailing tab":       {"BEARER \t"},
		"basic":              {"Basic Zm9vOmJhcg=="},
		"bogus":              {"Bogus"},
		"empty value":        {""},
		"blank value":        {"   "},
		"nbsp separator":     {"Bearer\u00a0bogus"},
		"nbsp only":          {"Bearer \u00a0"},
		"basic then bearer":  {"Basic x", "Bearer bogus"},
		"bearer then basic":  {"Bearer bogus", "Basic x"},
		"two bearers":        {"Bearer bogus", "Bearer bogus"},
		"two empty":          {"", ""},
		"tab, unknown token": {"Bearer\tbogus"},
	} {
		t.Run(name, func(t *testing.T) {
			c := c.With(t)
			var opts []webtest.Option
			for _, v := range headers {
				opts = append(opts, func(r *http.Request) { r.Header.Add("Authorization", v) })
			}
			c.Get("/api/me", opts...).WantStatus(http.StatusUnauthorized)
			csrfTestJSON(c, http.MethodPost, "/api/sync", `{"cursor":0}`, opts...).WantStatus(http.StatusUnauthorized)
		})
	}
}

func TestOfflinePageShellsArePublic(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "shell@example.test", true)
	anon := webtest.New(t, s.routes, csrfTestOrigin)
	signedIn := webtest.New(t, s.routes, csrfTestOrigin)
	signedIn.PostForm("/account/login", url.Values{"email": {"shell@example.test"}, "password": {testPassword}}).
		WantStatus(http.StatusSeeOther)
	for _, path := range []string{"/", "/songs", "/progress", "/about"} {
		t.Run(path, func(t *testing.T) {
			a, b := anon.With(t).Get(path), signedIn.With(t).Get(path)
			a.WantStatus(http.StatusOK)
			b.WantStatus(http.StatusOK)
			if a.Body != b.Body || b.Header.Get("Set-Cookie") != "" ||
				a.Header.Get("Cache-Control") != b.Header.Get("Cache-Control") {
				t.Error("offline shell depends on authentication")
			}
		})
	}
	for _, path := range []string{"/account", "/admin/users", "/api/me"} {
		t.Run(path, func(t *testing.T) {
			res := signedIn.With(t).Get(path)
			res.WantStatus(http.StatusOK)
			if res.Header.Get("Cache-Control") != "no-store" {
				t.Error("authenticated response is cacheable")
			}
		})
	}
}

func csrfTestJSON(c *webtest.Client, method, path, body string, opts ...webtest.Option) *webtest.Response {
	req := c.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return c.Do(req, opts...)
}

func TestBearerParsing(t *testing.T) {
	for _, tc := range []struct {
		name     string
		headers  []string
		token    string
		supplied bool
	}{
		{name: "absent"},
		{name: "other scheme", headers: []string{"Basic value"}, supplied: true},
		{name: "scheme without separator", headers: []string{"Bogus"}, supplied: true},
		{name: "empty value", headers: []string{""}, supplied: true},
		{name: "bare scheme", headers: []string{"Bearer"}, supplied: true},
		{name: "one trailing space", headers: []string{"Bearer "}, supplied: true},
		{name: "mixed case and trailing whitespace", headers: []string{"bEaReR  \t"}, supplied: true},
		{name: "non-breaking space separator", headers: []string{"Bearer\u00a0token"}, supplied: true},
		{name: "two headers, first valid", headers: []string{"Bearer token", "Bearer token"}, supplied: true},
		{name: "two headers, first foreign", headers: []string{"Basic x", "Bearer token"}, supplied: true},
		{name: "valid", headers: []string{"bEaReR token "}, token: "token", supplied: true},
		{name: "valid with a tab", headers: []string{"Bearer\ttoken"}, token: "token", supplied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := http.NewRequest(http.MethodGet, csrfTestOrigin, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, v := range tc.headers {
				r.Header.Add("Authorization", v)
			}
			if token, supplied := bearer(r); token != tc.token || supplied != tc.supplied {
				t.Fatalf("unexpected bearer parse (supplied=%t, want %t)", supplied, tc.supplied)
			}
		})
	}
}

// A live token is not enough when the request names two Authorization values:
// the parser may not quietly pick one of them.
func TestSecondAuthorizationHeaderIsRefused(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "twice@example.test", false)
	token := s.deviceToken(t, "twice@example.test", testPassword)
	c := webtest.New(t, s.routes, csrfTestOrigin)
	add := func(values ...string) webtest.Option {
		return func(r *http.Request) {
			for _, v := range values {
				r.Header.Add("Authorization", v)
			}
		}
	}
	c.Get("/api/me", add("Bearer "+token)).WantStatus(http.StatusOK)
	c.Get("/api/me", add("Bearer\t"+token)).WantStatus(http.StatusOK)
	c.Get("/api/me", add("Bearer "+token, "Bearer "+token)).WantStatus(http.StatusUnauthorized)
	c.Get("/api/me", add("Basic x", "Bearer "+token)).WantStatus(http.StatusUnauthorized)
	c.Get("/api/me", add("Bearer\u00a0"+token)).WantStatus(http.StatusUnauthorized)
}
