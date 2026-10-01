// Package middleware holds the HTTP wrappers every response passes through.
package middleware

import (
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
)

// Middleware wraps a handler.
type Middleware func(http.Handler) http.Handler

// Policy is the deployment-dependent part of the security headers.
type Policy struct {
	// HSTS adds Strict-Transport-Security; see config.Config.HSTS.
	HSTS bool
}

// CSP is the Content-Security-Policy every response carries. It is a
// constant because nothing about it varies by deployment: every script,
// stylesheet and font is served from this origin.
//
//   - script-src 'self': the Deno bundles are files, and no template carries
//     an inline script or on*= handler (a test enforces it).
//   - style-src 'self': no template carries a style attribute. Styling the
//     frontend applies through the CSSOM (element.style.x) is not governed by
//     CSP at all, so the SVG views need no concession.
//   - font-src/img-src data:: VexFlow ships its music font embedded as a
//     data: URI and loads it through FontFace. The alternative is its "core"
//     build, which fetches fonts from a CDN at runtime.
//   - connect-src 'self': stage 1 makes no requests of its own; stage 2's API
//     is same-origin.
//
// script-src and connect-src each carry one more origin: Cloudflare's Web
// Analytics beacon. Cloudflare's proxy *injects* that script into the HTML in
// front of this server — the page asks for a script this code never wrote —
// so refusing it put a violation in the console on every load while the
// analytics silently collected nothing. Two hosts because they are two
// different things, as in ~/dev/teleprompter: the beacon is fetched from
// static.cloudflareinsights.com (script-src) and reports to
// cloudflareinsights.com/cdn-cgi/rum (connect-src). Turning off the injection
// in the Cloudflare dashboard is the way back out; nothing here depends on it
// loading.
//
// If something inline is ever genuinely needed, the answer is a per-response
// nonce, never 'unsafe-inline' — that cannot be scoped to the code that asked.
const CSP = "default-src 'self'; " +
	"script-src 'self' https://static.cloudflareinsights.com; " +
	"style-src 'self'; " +
	"img-src 'self' data:; " +
	"font-src 'self' data:; " +
	"connect-src 'self' https://cloudflareinsights.com; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

// PermissionsPolicy grants this origin the two inputs the app reads: Web
// MIDI (a keyboard) and the microphone (a guitar through an audio
// interface, for pitch detection). Nothing else, and only to this origin, so
// a framed third-party page can never prompt for either under our name.
const PermissionsPolicy = "midi=(self), microphone=(self), camera=(), geolocation=(), payment=()"

// SecurityHeaders sets the headers every response wants.
func SecurityHeaders(p Policy) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("Content-Security-Policy", CSP)
			h.Set("Permissions-Policy", PermissionsPolicy)
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			if p.HSTS {
				// No preload: getting onto the list has a slow exit, and it is
				// the operator's decision, not this project's.
				h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// statusRecorder captures the status code for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Logging writes one structured line per request. Static assets are skipped:
// every page load fetches several, and they drown out the requests that say
// what people are actually doing.
func Logging(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			if strings.HasPrefix(r.URL.Path, "/static/") && rec.status < 400 {
				return
			}
			log.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"dur", time.Since(start).Round(time.Microsecond))
		})
	}
}

// Chain applies middleware so the first listed is the outermost.
func Chain(h http.Handler, m ...Middleware) http.Handler {
	for _, mw := range slices.Backward(m) {
		h = mw(h)
	}
	return h
}
