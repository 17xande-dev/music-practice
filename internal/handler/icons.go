package handler

import (
	"fmt"
	"html/template"
)

// icons are the transport and view icons, drawn here (24×24, stroke in
// currentColor, so they take the text colour and need no licence). Inline
// SVG in the page, not an icon font or a CDN, and with presentation
// attributes only, so the CSP is unaffected.
var icons = map[string]string{
	"play":         `<path d="M7.5 4.8v14.4L19 12z" fill="currentColor"/>`,
	"pause":        `<rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>`,
	"stop":         `<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>`,
	"restart":      `<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.2v4.5H9"/>`,
	"skip-back":    `<path d="M6 5v14"/><path d="M18 5.5 9.5 12l8.5 6.5z" fill="currentColor"/>`,
	"skip-forward": `<path d="M18 5v14"/><path d="M6 5.5 14.5 12 6 18.5z" fill="currentColor"/>`,
	"to-start":     `<path d="M5 5v14"/><path d="M12.5 6 7 12l5.5 6zM19.5 6 14 12l5.5 6z" fill="currentColor"/>`,
	"maximize":     `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`,
	"minimize":     `<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>`,
	"view-line":    `<path d="M3 7h12M3 12h16M3 17h12"/><path d="M16.5 8.5 20 12l-3.5 3.5"/>`,
	"view-page":    `<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>`,
	"zoom-in":      `<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M8 10.5h5M10.5 8v5"/>`,
	"zoom-out":     `<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M8 10.5h5"/>`,
	"command":      `<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>`,
}

// icon renders one of icons. An unknown name is an error, so a typo fails
// the page render (and its test) rather than drawing nothing.
func icon(name string) (template.HTML, error) {
	body, ok := icons[name]
	if !ok {
		return "", fmt.Errorf("handler: no icon %q", name)
	}
	return template.HTML(`<svg class="icon icon-` + name + `" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` + body + `</svg>`), nil
}
