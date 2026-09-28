# Music Practice

A site for practising scales on a MIDI instrument such as a digital piano. You connect the
instrument in the browser, pick a scale, and play it. The page shows your playing live on a staff
and an on-screen keyboard, and grades it.

- **Scales:** major, the three minors (natural, harmonic, melodic), the other five modes, major and
  minor pentatonic, blues and chromatic. All 12 keys are offered, spelled properly: F♯ major shows
  E♯, G♯ harmonic minor shows F𝄪, and C♯/D♭ are both offered where both are in use.
- **Options:** right hand, left hand or hands together; 1–4 octaves; up only, or up and down.
- **Notes-only grading:** the page waits for each correct note. It reports accuracy, wrong notes,
  evenness of spacing, dynamics spread, and, for hands together, how often the hands were apart.
- **Grading with a metronome:** a one-bar count-in, then each note is graded on the beat, early or
  late against the click. A per-note timing chart and a rushing/dragging hint follow each run. A
  latency offset compensates for the delay in your setup.
- **Progress:** stage 1 has no accounts. Every run is saved in your browser's localStorage, and the
  Progress page shows trends, per-scale bests and recent sessions. History can be exported and
  imported as JSON.
- **No instrument?** The computer keyboard works as a fallback (<kbd>A</kbd>–<kbd>J</kbd> for white
  keys, <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd> for black keys). It plays
  pitch classes, and the octave is picked for you.

## Browser support

Web MIDI works in **Chrome, Edge and Firefox**, which asks for permission. It does not work in
Safari. It also requires a **secure context**: `http://localhost` is fine for development, but any
real deployment must be served over **HTTPS**, or the browser hides the API entirely. The page
detects each case (no support, insecure origin, permission refused) and says so. The
computer-keyboard fallback works everywhere.

## Develop

```sh
make dev     # rebundle TypeScript on change + run the server with -dev on :8080
make check   # the gate before any commit: gofmt, vet, deno check/lint/fmt/test, bundle, go test
make build   # bundle, then compile bin/music-practice with everything embedded
make docker  # multi-stage image: Deno bundle → Go build → distroless
```

The tools are Go 1.27 and Deno 2.9, pinned in `mise.toml`. Configuration comes from the environment
only:

| Variable           | Default | Meaning                                                                             |
| ------------------ | ------- | ----------------------------------------------------------------------------------- |
| `ADDR`             | `:8080` | Listen address                                                                      |
| `HSTS`             | off     | `1` to send Strict-Transport-Security. Only on an HTTPS deployment, never localhost |
| `SHUTDOWN_TIMEOUT` | `10s`   | Grace period for in-flight requests on SIGTERM                                      |

## How it fits together

Go serves the pages and the static files. Everything a visitor does happens in the browser, in
TypeScript that Deno bundles.

```
main.go                     server wiring, graceful shutdown, -dev flag
internal/config/            environment → one Config struct
internal/middleware/        security headers (CSP, Permissions-Policy: midi=(self)), access log
internal/handler/           page templates + static assets, all go:embed'ed
  templates/                layout + one template set per page
  static/styles.css         the theme (custom properties, light and dark)
  static/dist/              Deno output — build artefact, not committed
frontend/
  practice.ts progress.ts   the two page controllers (bundle entry points)
  lib/theory.ts             spelled notes, scale definitions, the step sequence
  lib/engine.ts             grading: NotesEngine and TempoEngine (pure, no DOM)
  lib/midi.ts               Web MIDI input, hot-plug
  lib/qwerty.ts             computer-keyboard fallback + a small synth
  lib/metronome.ts          clicks scheduled on the audio clock
  lib/keyboard_view.ts      SVG piano
  lib/staff_view.ts         VexFlow staff / grand staff
  lib/timing_chart.ts       per-note timing chart (tempo results)
  lib/accuracy_chart.ts     accuracy trend (progress page)
  lib/progress_store.ts     localStorage history + settings, export/import
  lib/*_test.ts             Deno tests
```

Deno bundles only the two TypeScript entry points, not HTML, because the pages are Go templates.
Stage 2 needs server-rendered pages for signed-in users. Without code-splitting the bundle names
stay fixed (`dist/practice.js`, `dist/progress.js`), and Go's `{{asset}}` adds a content hash to
each URL, so assets are cached `immutable` and a rebuild invalidates them. A binary built without
the bundle refuses to start instead of serving pages whose scripts 404.

**Timing.** MIDI events carry `performance.now()` timestamps from when they arrived. Metronome
clicks are scheduled on the Web Audio clock, and `getOutputTimestamp()` maps them to the same
`performance.now()` timeline at the moment they are _heard_. The grading therefore compares like
with like; setTimeout would drift by about as much as it measures. The latency offset covers what's
left, mainly the instrument's own delay.

**Why no framework.** The UI is a handful of forms and two SVG views driven by one state machine per
page. Plain DOM code keeps the bundle to VexFlow plus a few kilobytes and keeps the CSP simple.

### Dependencies

`go.mod` has none: the server is stdlib only. The frontend has one runtime dependency:

| Dependency                    | Why                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm:vexflow@5.0.0`           | Staff notation. Clefs, key signatures, accidentals (including the naturals melodic minor needs), ledger lines and beaming are fiddly to get right by hand. Pinned exactly because rendering depends on its layout internals. Imported via `vexflow/bravura`, which embeds its fonts as data: URIs; the default build would fetch them from a CDN. |
| `jsr:@std/assert` (test only) | Assertions for `deno test`                                                                                                                                                                                                                                                                                                                        |

Deno supplies the bundler, type checker, linter, formatter and test runner. There is no npm project
and no Node toolchain.

### Security

- The CSP is a fixed constant pinned by a test: `default-src 'self'`, `script-src 'self'`,
  `style-src 'self'`, and no `unsafe-inline` or `unsafe-eval` anywhere. `font-src` and `img-src`
  allow `data:` for VexFlow's embedded fonts.
- No served template contains an inline style, event handler or script. A test walks every page to
  enforce this, because the CSP would silently refuse them and handler tests never run JavaScript.
- `Permissions-Policy` grants `midi` to this origin only.
- The static route serves only listed file extensions.
- Nothing about a visitor reaches the server. History stays in their browser, and imported files are
  validated and rebuilt field by field before storage.

There are no `STATIC_DIR` or `TEMPLATE_DIR` overrides: this is a single deployment, not a project
for others to reskin.

## Testing

`make check` runs everything CI runs:

- **Deno:** scale spelling across every tonic × type × octave count; the grading engines driven by
  synthetic note streams (wrong notes, repeats, hands-together asynchrony, early/late/missed,
  latency offset, fast subdivisions); MIDI parsing; the computer-keyboard octave choice; metronome
  timing; staff clef and key helpers; chart ranges; and the progress store against in-memory, full
  and throwing storage, including hostile imports.
- **Go:** routes, the pinned security headers, the static extension gate, content-hashed asset URLs,
  the missing-bundle boot failure, and the no-inline-content rule.

The browser is the other half. UI changes are checked in Chrome through the DevTools MCP server, at
desktop and phone widths and in light and dark themes, with the console open for CSP violations.
DevTools can't provide a MIDI device, so the practice page exposes
`window.__practice.note(midi, on, t)`, which feeds a note through the same path a MIDI message
takes. A real instrument still needs a human.

## Deploying

Live at **https://music.17xande.dev**, set up like the teleprompter app:

- **Coolify** on the Oracle free-tier VM (the same box Coolify itself runs on) builds
  `docker-compose.yaml` with the Docker Compose build pack. A push to `master` deploys through the
  GitHub webhook.
- **Traefik**, managed by Coolify, terminates TLS at the origin with a Let's Encrypt certificate.
  The domain is set on the `music-practice` compose service in Coolify's Domains tab, not the
  app-level field.
- **Cloudflare** DNS: a proxied `A` record to the VM. The zone runs SSL in Full (strict) mode, so
  the origin certificate has to be real, and it is. `HSTS=1` is safe for that reason.

Traefik only routes to a container whose Docker healthcheck is `healthy`. The runtime image is
distroless (no shell, no `wget`), so the healthcheck runs `music-practice -healthcheck`, which
probes `/healthz` itself. A test stops it from ever shelling out again. If the site returns 503 at
the origin (526 through Cloudflare), check
`docker inspect <container> --format '{{.State.Health.Status}}'` first. Coolify's own
"running:healthy" status does not reflect Docker's health state.

## Decisions still open

| Decision                                                                         | Trigger                                                                     |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Stage 2: accounts, server-side history (SQLite)                                  | Start of stage 2. The localStorage export (`version: 1`) is the import path |
| Fingering hints on the staff                                                     | After stage 1 feedback                                                      |
| Microphone pitch input for acoustic instruments                                  | If players without MIDI matter                                              |
| Arpeggios, contrary motion, scales in thirds/sixths                              | After scales settle                                                         |
