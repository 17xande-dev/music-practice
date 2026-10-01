package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func serve(p Policy) *httptest.ResponseRecorder {
	h := SecurityHeaders(p)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	return rec
}

// The policy is pinned verbatim so loosening it is a deliberate, reviewed
// edit to this test rather than a side effect of some other change.
func TestCSPIsPinned(t *testing.T) {
	got := serve(Policy{}).Header().Get("Content-Security-Policy")
	want := "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
		"style-src 'self'; img-src 'self' data:; font-src 'self' data:; " +
		"connect-src 'self' https://cloudflareinsights.com; object-src 'none'; " +
		"base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	if got != want {
		t.Errorf("CSP changed:\n got %s\nwant %s", got, want)
	}
	for _, bad := range []string{"unsafe-inline", "unsafe-eval", "*"} {
		if strings.Contains(got, bad) {
			t.Errorf("CSP contains %s", bad)
		}
	}
}

// Without midi=(self) the browser refuses requestMIDIAccess outright, and
// without microphone=(self) getUserMedia — so guitar input — fails the same
// way. Pinned whole, so granting anything more is a deliberate edit here.
func TestPermissionsPolicyAllowsMIDIAndMicrophone(t *testing.T) {
	got := serve(Policy{}).Header().Get("Permissions-Policy")
	want := "midi=(self), microphone=(self), camera=(), geolocation=(), payment=()"
	if got != want {
		t.Errorf("Permissions-Policy changed:\n got %s\nwant %s", got, want)
	}
}

func TestHSTSOnlyWhenAsked(t *testing.T) {
	if v := serve(Policy{}).Header().Get("Strict-Transport-Security"); v != "" {
		t.Errorf("HSTS sent by default: %q", v)
	}
	if v := serve(Policy{HSTS: true}).Header().Get("Strict-Transport-Security"); v == "" {
		t.Error("HSTS missing when enabled")
	}
}
