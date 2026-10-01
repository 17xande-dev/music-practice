package handler

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	h, err := New(Options{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatalf("New: %v (did `deno task bundle` run?)", err)
	}
	return h.Routes()
}

func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", target, nil))
	return rec
}

// pagePaths are every HTML page the server renders. The inline-content test
// walks these, so a page added to Routes must be added here too — and the
// minimum-count check stops the list silently emptying.
var pagePaths = []string{"/", "/songs", "/progress", "/about"}

func TestPagesRender(t *testing.T) {
	h := newTestHandler(t)
	for _, p := range pagePaths {
		rec := get(t, h, p)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d", p, rec.Code)
			continue
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("%s: content-type %q", p, ct)
		}
	}
}

// Each page must load its own bundle — not the other page's, which is what a
// single flat template set would silently produce.
func TestEachPageLoadsItsOwnBundle(t *testing.T) {
	h := newTestHandler(t)
	for path, want := range map[string]string{
		"/": "dist/practice.js", "/songs": "dist/songs.js", "/progress": "dist/progress.js",
	} {
		body := get(t, h, path).Body.String()
		if !regexp.MustCompile(`src="/static/` + regexp.QuoteMeta(want) + `\?v=[0-9a-f]{12}"`).MatchString(body) {
			t.Errorf("%s does not load hashed %s", path, want)
		}
	}
}

// Inline styles and event handlers are refused by the CSP (style-src and
// script-src 'self'). The page would still render and return 200 — only a
// real browser shows that the handler never runs — so this is checked here.
func TestNoInlineStyleOrHandlers(t *testing.T) {
	h := newTestHandler(t)
	onAttr := regexp.MustCompile(`(?i)\son[a-z]+\s*=`)
	styleAttr := regexp.MustCompile(`(?i)\sstyle\s*=`)
	inlineScript := regexp.MustCompile(`(?i)<script(?:\s[^>]*)?>\s*[^<\s]`)
	checked := 0
	for _, p := range pagePaths {
		body := get(t, h, p).Body.String()
		if onAttr.MatchString(body) {
			t.Errorf("%s contains an inline on*= handler", p)
		}
		if styleAttr.MatchString(body) {
			t.Errorf("%s contains a style= attribute", p)
		}
		if inlineScript.MatchString(body) {
			t.Errorf("%s contains an inline script", p)
		}
		checked++
	}
	if checked < 2 {
		t.Fatalf("checked %d pages, want at least 2", checked)
	}
}

func TestUnknownPathIs404(t *testing.T) {
	h := newTestHandler(t)
	for _, p := range []string{"/nope", "/progress/extra", "/static/nope.js"} {
		if rec := get(t, h, p); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", p, rec.Code)
		}
	}
}

func TestHealthz(t *testing.T) {
	if rec := get(t, newTestHandler(t), "/healthz"); rec.Code != 200 || rec.Body.String() != "ok\n" {
		t.Errorf("healthz: %d %q", rec.Code, rec.Body.String())
	}
}

func TestStaticServesHashedAssetsImmutable(t *testing.T) {
	a := NewAssets(fstest.MapFS{
		"styles.css":       {Data: []byte("body{}")},
		"dist/practice.js": {Data: []byte("x")},
	}, false)
	for _, name := range []string{"styles.css", "dist/practice.js"} {
		url := a.URL(name)
		if !regexp.MustCompile(`^/static/` + regexp.QuoteMeta(name) + `\?v=[0-9a-f]{12}$`).MatchString(url) {
			t.Fatalf("URL(%q) = %q", name, url)
		}
		rec := get(t, a, url)
		if rec.Code != 200 {
			t.Fatalf("%s: status %d", url, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			t.Errorf("%s: Cache-Control %q", url, cc)
		}
	}
}

// A hash changes when the content does; that is what makes immutable caching
// safe across rebuilds.
func TestAssetHashTracksContent(t *testing.T) {
	a := NewAssets(fstest.MapFS{"a.js": {Data: []byte("one")}}, false)
	b := NewAssets(fstest.MapFS{"a.js": {Data: []byte("two")}}, false)
	if a.URL("a.js") == b.URL("a.js") {
		t.Error("different content produced the same URL")
	}
}

// Only listed extensions are served, so a stray source file, template or
// secret dropped under static/ is never published.
func TestStaticRefusesUnlistedExtensions(t *testing.T) {
	a := NewAssets(fstest.MapFS{
		"page.html":     {Data: []byte("<p>")},
		".env":          {Data: []byte("SECRET=1")},
		"x.ts":          {Data: []byte("let x")},
		"dist/.gitkeep": {Data: nil},
	}, false)
	for _, name := range []string{"page.html", ".env", "x.ts", "dist/.gitkeep"} {
		if rec := get(t, a, "/static/"+name); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", name, rec.Code)
		}
	}
}

// A build that skipped the bundle step must refuse to start rather than
// serve pages whose scripts 404.
func TestCheckReportsMissingBundle(t *testing.T) {
	a := NewAssets(fstest.MapFS{"styles.css": {Data: []byte("")}}, false)
	err := a.Check("styles.css", "dist/practice.js")
	if err == nil || !strings.Contains(err.Error(), "dist/practice.js") {
		t.Errorf("Check error = %v", err)
	}
}

// The third-party notices must stay published: the BSD-3 and OFL terms of
// what the bundles ship require them, and the About page links to them.
func TestLicenceNoticesAreServed(t *testing.T) {
	h := newTestHandler(t)
	rec := get(t, h, "/static/licenses.txt")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("content-type %q", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{"OpenSheetMusicDisplay", "BSD-3-Clause", "SIL Open Font License", "pitchy", "Steinberg"} {
		if !strings.Contains(body, want) {
			t.Errorf("licenses.txt lacks %q", want)
		}
	}
	if about := get(t, h, "/about").Body.String(); !strings.Contains(about, `href="/static/licenses.txt?v=`) {
		t.Error("the About page does not link the licence notices")
	}
}

// The service worker must be served from the root (its scope is the
// whole site), never HTTP-cached, and versioned by the assets so a deploy
// replaces the old worker and its caches.
func TestServiceWorker(t *testing.T) {
	h := newTestHandler(t)
	rec := get(t, h, "/sw.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("content-type %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("cache-control %q", cc)
	}
	if !regexp.MustCompile(`^const VERSION = "[0-9a-f]{12}";\n`).MatchString(rec.Body.String()) {
		t.Errorf("worker does not start with its version: %.60q", rec.Body.String())
	}
	page := get(t, h, "/").Body.String()
	if !strings.Contains(page, `rel="manifest" href="/static/manifest.webmanifest?v=`) {
		t.Error("pages do not link the web app manifest")
	}
	if m := get(t, h, "/static/manifest.webmanifest"); m.Header().Get("Content-Type") != "application/manifest+json" {
		t.Errorf("manifest content-type %q", m.Header().Get("Content-Type"))
	}
}

// Any change to any asset gives a new version.
func TestAssetVersionFollowsContent(t *testing.T) {
	a := NewAssets(fstest.MapFS{"a.js": {Data: []byte("1")}, "b.css": {Data: []byte("x")}}, false)
	b := NewAssets(fstest.MapFS{"a.js": {Data: []byte("1")}, "b.css": {Data: []byte("y")}}, false)
	if a.Version() == b.Version() {
		t.Error("different assets, same version")
	}
	if a.Version() != NewAssets(fstest.MapFS{"a.js": {Data: []byte("1")}, "b.css": {Data: []byte("x")}}, false).Version() {
		t.Error("same assets, different version")
	}
}
