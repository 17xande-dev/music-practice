// Package handler is the HTTP surface: page rendering and static assets.
//
// Stage 1 has no server-side state. The pages are shells; everything a
// visitor does — MIDI input, grading, progress — happens in the Deno-bundled
// TypeScript, and progress lives in their browser's localStorage.
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
}

// Handler renders pages and serves assets.
type Handler struct {
	log    *slog.Logger
	dev    bool
	tmplFS fs.FS
	assets *Assets
	pages  map[string]*template.Template
}

// pageFiles are the page templates, each parsed into its own set with the
// layout. One set per page, because every page defines "content": in a single
// flat set the last file parsed would silently win and pages would render as
// each other.
var pageFiles = []string{"practice.html", "progress.html"}

// Bundles are the Deno outputs the pages load. Checked at boot so a binary
// built without `make bundle` refuses to start instead of serving dead pages.
var Bundles = []string{"dist/practice.js", "dist/progress.js", "dist/pitch_worklet.js"}

// New builds the handler, parsing every template up front so a template
// error is a startup failure.
func New(o Options) (*Handler, error) {
	h := &Handler{log: o.Log, dev: o.Dev}
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
	funcs := template.FuncMap{"asset": h.assets.URL}
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
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", h.page("practice.html", "Practice"))
	mux.HandleFunc("GET /progress", h.page("progress.html", "Progress"))
	mux.Handle("GET /static/", h.assets)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("ok\n"))
	})
	return mux
}

// pageData is what every page template receives.
type pageData struct {
	Title string
	// Nav is the page's own filename stem, for marking the current nav link.
	Nav string
}

func (h *Handler) page(file, title string) http.HandlerFunc {
	nav := file[:len(file)-len(path.Ext(file))]
	return func(w http.ResponseWriter, r *http.Request) {
		pages := h.pages
		if h.dev {
			p, err := h.parsePages()
			if err != nil {
				h.serverError(w, err)
				return
			}
			pages = p
		}
		// Render into a buffer so a template error can still be a clean 500
		// rather than half a page under a 200.
		var buf bytes.Buffer
		if err := pages[file].ExecuteTemplate(&buf, "layout", pageData{Title: title, Nav: nav}); err != nil {
			h.serverError(w, err)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		buf.WriteTo(w)
	}
}

func (h *Handler) serverError(w http.ResponseWriter, err error) {
	h.log.Error("render", "err", err)
	http.Error(w, "internal server error", http.StatusInternalServerError)
}
