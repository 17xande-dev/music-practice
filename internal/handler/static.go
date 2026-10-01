package handler

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
)

// contentTypes maps an extension to what the file is served as.
//
// An explicit map rather than mime.TypeByExtension: an extension not listed
// here is not served at all, so a stray .html, .ts or .env under static/
// cannot be published by accident. .map is listed because the Deno bundles
// ship linked sourcemaps — the source is open anyway, and a readable stack
// trace from a user's browser is worth more than hiding it.
var contentTypes = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".map":   "application/json",
	".css":   "text/css; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	// The licence notices, and the starter scores the songs page offers.
	".txt":      "text/plain; charset=utf-8",
	".musicxml": "application/vnd.recordare.musicxml+xml",
}

type asset struct {
	body        []byte
	contentType string
	etag        string
	url         string
}

// Assets is the served static set: styles, icons, and the Deno bundles under
// dist/. Each file's URL carries a hash of its content, so it can be cached
// forever and a rebuild invalidates it without any version to bump — which is
// also why the bundler need not emit hashed filenames.
type Assets struct {
	fsys   fs.FS
	reload bool

	once sync.Once
	set  map[string]asset
	err  error
}

// NewAssets serves fsys. With reload set, every lookup re-reads the files, so
// `deno task bundle-watch` output shows on a refresh; that is a development
// mode only, since it reads every asset per request.
func NewAssets(fsys fs.FS, reload bool) *Assets {
	return &Assets{fsys: fsys, reload: reload}
}

func (a *Assets) current() (map[string]asset, error) {
	if a.reload {
		return loadAssets(a.fsys)
	}
	a.once.Do(func() { a.set, a.err = loadAssets(a.fsys) })
	return a.set, a.err
}

func loadAssets(fsys fs.FS) (map[string]asset, error) {
	out := map[string]asset{}
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		ct, ok := contentTypes[path.Ext(name)]
		if !ok {
			// Embedded but never served: .gitkeep, READMEs, and anything else
			// without a listed extension.
			return nil
		}
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		digest := hex.EncodeToString(sum[:])[:12]
		out[name] = asset{
			body:        body,
			contentType: ct,
			etag:        `"` + digest + `"`,
			url:         "/static/" + name + "?v=" + digest,
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("handler: load static assets: %w", err)
	}
	return out, nil
}

// Check reports a problem loading the set, or a required file that is
// missing, so an unbundled build fails at boot rather than serving pages
// whose scripts 404.
func (a *Assets) Check(required ...string) error {
	set, err := a.current()
	if err != nil {
		return err
	}
	var missing []string
	for _, name := range required {
		if _, ok := set[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("handler: missing static assets %s (run `make bundle` before building)",
			strings.Join(missing, ", "))
	}
	return nil
}

// URL is the template function behind {{asset "styles.css"}}.
func (a *Assets) URL(name string) string {
	set, err := a.current()
	if err != nil {
		return "/static/unavailable/" + name
	}
	if x, ok := set[name]; ok {
		return x.url
	}
	// Visible in the page rather than silently absent, so a mistyped name
	// fails loudly while it is being written.
	return "/static/missing/" + name
}

func (a *Assets) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/static/")
	set, err := a.current()
	if err != nil {
		http.Error(w, "static assets unavailable", http.StatusInternalServerError)
		return
	}
	x, ok := set[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", x.contentType)
	w.Header().Set("ETag", x.etag)
	// Immutable is honest only because the URL is content-addressed. A
	// request without ?v= (a sourcemap reference, say) still gets revalidated
	// through the ETag.
	if r.URL.Query().Has("v") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(x.body))
}
