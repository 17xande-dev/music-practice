# Music Practice

A site for practising scales and songs on a MIDI instrument such as a digital piano (scales also on
guitar). You connect the instrument in the browser, pick a scale or open a score, and play. The page
shows your playing live on the music and an on-screen keyboard, and grades it.

- **Scales:** major, the three minors (natural, harmonic, melodic), the other five modes, major and
  minor pentatonic, blues and chromatic; plus major and minor arpeggios (root position, fingered
  from the standard arpeggio tables) and triad inversions as block chords (root, first and second
  inversion up the keyboard, fingered 1-3-5 / 1-2-5 and 5-3-1 / 5-2-1). Chord drills are piano only:
  the guitar's pitch tracker hears one note at a time. All 12 keys are offered, spelled properly: F♯
  major shows E♯, G♯ harmonic minor shows F𝄪, and C♯/D♭ are both offered where both are in use.
- **Picking a key:** a circle of fifths, with major keys outside and relative minors inside. Tap a
  key, then pick a variant (Lydian, harmonic minor, blues…). Each outer wedge shows its key
  signature, and the selected key's neighbours are shaded and labelled with Roman numerals.
- **Options:** right hand, left hand or hands together; 1–4 octaves; up only, or up and down.
- **Notes-only grading:** the page waits for each correct note. It reports accuracy, wrong notes,
  evenness of spacing, dynamics spread, and, for hands together, how often the hands were apart.
- **Grading with a metronome:** a one-bar count-in, then each note is graded on the beat, early or
  late against the click. A per-note timing chart and a rushing/dragging hint follow each run. A
  latency offset compensates for the delay in your setup.
- **Learn mode:** for something new, on both pages. The cursor waits for each note, the next keys
  are highlighted with their fingers, and a pass ends with the time it took rather than a grade.
  Learn passes never go into the graded history, so early stumbles don't pull down trends or bests.
  They go into a separate learning log instead: time spent, passes, and the measures you stumbled
  in.
- **Progress:** stage 1 has no accounts. Every run is saved in your browser's localStorage, and the
  Progress page shows trends, per-scale bests and recent sessions, and, in its own section, time
  spent in Learn mode. History can be exported and imported as JSON.
- **Guitar:** plug an electric guitar into the computer through a USB audio interface (a Rocksmith
  Real Tone cable, for example) and choose Guitar. The page detects the played note from the sound
  itself, using the McLeod Pitch Method in an AudioWorklet. You pick a fretboard position, and the
  fretboard shows that one fingering. Grading is by pitch: the same pitch can be played in several
  places, which one pickup can't tell apart, but inside a position each pitch has a single place.
  The staff uses standard guitar notation (treble clef, sounding an octave lower). A tuner readout
  shows the detected note and cents.
- **Fingering:** a "Show fingers" switch, off by default and remembered, puts finger numbers on the
  staff (above for the right hand, below for the left), on the key to play next, and in the
  fretboard dots. Piano uses standard scale fingering, worked out from the rules scale books follow,
  and matches them for every major and harmonic minor key in both hands. Guitar uses one finger per
  fret in the chosen position, with 0 for open strings. Notes outside the box get no number, since
  the hand has to shift.
- **Songs:** add a MusicXML score (`.musicxml` or zipped `.mxl`, as MuseScore, Sibelius, Finale and
  Dorico export it) and practise it on the Songs page. The score is rendered in the page and kept in
  your browser (IndexedDB), never uploaded. Modes: _learn_ (see above), _wait for each note_ (the
  cursor holds until you play the right notes), _play in time_ (a count-in and a metronome that
  follows the score's tempo marks; wrong, missed, early and late notes are graded), and _listen_
  (the app plays it). Each mode covers both hands or one, with the other hand optionally played for
  you, a range of measures, and a tempo as a percentage of the marked one, and can repeat the
  selection. Repeats in the score are played out. After a run, a heat map shows each measure from
  clean to troubled; clicking a measure, or "practise the weakest measures", sets up that passage.
  Fingering printed in the file shows with "Show fingers". A piano written as one two-staff part or
  as separate right/left-hand parts is graded as two hands; in a voice-and-piano song, the piano
  part is graded.
- **Shareable links:** the scales page keeps its address in step with the exercise on screen, e.g.
  `/?instrument=piano&key=F%23&scale=harmonic-minor&hands=both&octaves=2&dir=updown&mode=tempo&bpm=90&beat=2`,
  and "Copy link" copies it. Opening a link sets that exercise up; anything it leaves out keeps your
  own setting. Device-specific settings (MIDI device, latency offset, tuning reference) aren't
  shared. Parameters: `instrument` (piano, guitar), `key` (C, F#, Bb…), `scale` (major,
  natural-minor, harmonic-minor, melodic-minor, dorian, phrygian, lydian, mixolydian, locrian,
  major-pentatonic, minor-pentatonic, blues, chromatic), `hands` (rh, lh, both), `position` (guitar,
  0–12), `octaves` (1–4), `dir` (up, updown), `mode` (notes, tempo, learn), `bpm` (40–200), `beat`
  (notes per beat: 1, 2, 4), `fingers` (1 or 0).
- **Song cursor:** a soft vertical band follows the current step across the whole system, in every
  mode, like OpenSheetMusicDisplay's own cursor (which is an image the CSP won't load, so the page
  draws an equivalent band from OSMD's layout).
- **Look:** the palette is 17xande.dev's (warm near-black and orange in the dark theme, the same
  hues on cream in the light one). The feedback colours are checked with a palette validator for
  colour-blind separation and contrast.
- **Themes:** a sun/moon switch in the header picks light or dark for the whole site. Until it is
  used the site follows the system; once used, the pick is remembered (and applied before the page
  paints, so there is no flash). The same switch next to the music sets the sheet light or dark on
  its own; switching it back to the site's theme makes it follow the site again.
- **Installable, works offline:** a web app manifest and a service worker. After one visit every
  page, bundle and starter piece is cached, so the site runs without a connection; pages are fetched
  network-first so a deploy shows on the next visit online.
- **Latency calibration:** next to the latency offset, "Measure" plays a count-in and eight clicks;
  tapping along (any key, or a guitar pluck) measures the median delay and sets the offset.
- **Rubato (play freely):** a song mode for music that speeds up and slows down. The cursor waits
  for you, and timing is judged against your own tempo rather than a click: each note is expected
  where the last few notes' pace puts it, so a gradual ritardando or accelerando stays on time. The
  leeway is a slider (±10–50% of each note's length; strict 15, normal 25, relaxed 40), so the
  window in milliseconds narrows as you play faster. An optional guide click (a count-in at the
  marked tempo) isn't graded against; by default it then follows you, keeping to your tempo
  (smoothed, so one late note doesn't lurch it) and waiting when you pause, or it can stay steady to
  show you any drift. A long hesitation counts once, without throwing off the notes after it.
- **Song transport and views:** a transport bar (start, previous/next measure, play/pause, stop,
  restart) with keyboard shortcuts; pausing keeps the place and Play resumes from it. A continuous
  view lays the piece out as one line that scrolls with the cursor; the big screen fills the window
  with the music and puts the transport in a bar; zoom sizes the notation.
- **No instrument?** The computer keyboard works as a fallback (<kbd>A</kbd>–<kbd>J</kbd> for white
  keys, <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd> for black keys). It plays
  pitch classes, and the octave is picked for you.

## Keyboard shortcuts

`Ctrl+K` (`⌘K` on a Mac) opens the command palette, which lists every command and runs it by name;
`?` (or `Ctrl+/`) shows the shortcuts. Only keys the computer-keyboard fallback doesn't play as
notes are used on their own; everything else is an `Alt` (`⌥`) chord. A test keeps this table in
step with the pages.

| Keys                    | Scales page                                            | Songs page                                       |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `Space`                 | Start / stop (metronome mode); start over (notes only) | Play / pause                                     |
| `R`                     | Restart                                                | Restart from the beginning                       |
| `Esc`                   | Stop                                                   | Stop, and leave the big screen                   |
| `←` `→`                 |                                                        | Previous / next measure (hold to keep going)     |
| `Home`                  |                                                        | Go to the start                                  |
| `Alt+F`                 |                                                        | Big screen                                       |
| `Alt+V`                 |                                                        | Continuous / page view                           |
| `Alt+J`                 |                                                        | Cursor flows with the music / jumps note to note |
| `Alt+=` `Alt+−`         |                                                        | Bigger / smaller notes                           |
| `Alt+L`                 |                                                        | Repeat the selection on / off                    |
| `Alt+M`                 |                                                        | Metronome on / off                               |
| `Alt+N`                 | Show / hide fingers                                    | Show / hide fingers                              |
| `Alt+B`                 | Music sheet light / dark                               | Music sheet light / dark                         |
| `Alt+C`                 | Copy link to the exercise                              |                                                  |
| `Alt+T`                 | Light / dark theme                                     | Light / dark theme                               |
| `Alt+1` `Alt+2` `Alt+3` | Go to Scales / Songs / Progress                        | Go to Scales / Songs / Progress                  |
| `Ctrl+K`                | Command palette                                        | Command palette                                  |
| `?`                     | Keyboard shortcuts                                     | Keyboard shortcuts                               |

On the Songs page, clicking a note on the score moves the play position there, and Play continues
from it. The About page has no script, so the palette and shortcuts other than the theme switch
aren't there.

## Browser support

Web MIDI works in **Chrome, Edge and Firefox**, which asks for permission. It does not work in
Safari. It also requires a **secure context**: `http://localhost` is fine for development, but any
real deployment must be served over **HTTPS**, or the browser hides the API entirely. The page
detects each case (no support, insecure origin, permission refused) and says so. MIDI access is only
requested once Piano is chosen, so guitarists are never asked for it. The computer-keyboard fallback
works everywhere.

Guitar input uses getUserMedia and an AudioWorklet, which all current browsers support, Safari
included. It also needs HTTPS, and permission to use the audio input.

## Develop

```sh
COOKIE_SECURE=0 make dev  # rebundle TypeScript on change + run with -dev on :8080
make check   # the gate before any commit: gofmt, vet, deno check/lint/fmt/test, bundle, go test
make build   # bundle, then compile bin/music-practice with everything embedded
make docker  # multi-stage image: Deno bundle → Go build → distroless
```

The tools are Go 1.27 and Deno 2.9, pinned in `mise.toml`. Configuration comes from the environment
only. `.env.example` lists local settings; copy it to `.env` and export the values if you want to
reuse them (`set -a; . ./.env; set +a`). The app does not load `.env` itself.

| Variable           | Default | Meaning |
| ------------------ | ------- | ------- |
| `ADDR`             | `:8080` | Listen address |
| `HSTS`             | `0`     | Send Strict-Transport-Security on HTTPS only. Accepts `1`, `0`, `true`, `false` |
| `COOKIE_SECURE`    | `1`     | Secure session cookie. Accepts `1`, `0`, `true`, `false`; `auto` is refused. Set `0` for plain-HTTP development |
| `BASE_URL`         | unset   | Optional canonical public origin: lowercase `scheme://host[:port]`, no path or trailing slash, omit default port. HTTPS required unless `COOKIE_SECURE=0` |
| `SESSION_IDLE` | `720h` | Browser inactivity limit (30 days) |
| `SESSION_ABSOLUTE` | `2160h` | Browser deadline from sign-in (90 days); also the cookie's deadline |
| `DEVICE_SESSION_IDLE` | `2160h` | iPad bearer-token inactivity limit (90 days) |
| `DEVICE_SESSION_ABSOLUTE` | `8760h` | iPad bearer-token deadline from sign-in (365 days) |
| `SHUTDOWN_TIMEOUT` | `10s`   | Grace period for in-flight requests on SIGTERM |
| `DB_PATH`          | none    | SQLite file for accounts and synced history. Required. `make dev` uses `data/dev.db` |
| `CLIENT_IP_HEADER` | unset   | Socket peer by default. Set a header only if all traffic arrives through a proxy that controls it. Production trusts `CF-Connecting-IP`; `X-Forwarded-For` uses the rightmost entry |

Session settings take positive Go durations in whole seconds (use `24h`, not `1d`).
Idle must not exceed absolute. Last use is recorded at most hourly, so idle expiry can arrive
up to an hour early. For a session to renew its idle deadline on activity, set idle above `1h`.

For sign-in over plain HTTP on a LAN, set `COOKIE_SECURE=0` and use the LAN origin for `BASE_URL`
(e.g. `http://192.0.2.1:8080`). Forwarded protocol headers do not change cookie security.

`music-practice -migrate-status` lists each database migration as applied or pending. The server
applies pending ones itself on startup, each in its own transaction. Migrations are goose files in
`internal/db/migrations/` (`-- +goose Up`), run through sqlitekit's `goosestrict`, whose version table
is STRICT like the rest. A database written before goose (tables and a `PRAGMA user_version`, no
`goose_db_version` table) is adopted once at that version on first start; one with tables and no
recorded version, or one newer than the binary, is refused. `-migrate-status` reports such a
database without adopting it.

Accounts are created by an admin in the admin pages; there is no self-service sign-up. Two commands
cover what the pages cannot: creating the first admin, and getting back in when every admin is
locked out. Each prints a generated password once:

```sh
docker exec <container> /music-practice -add-admin you@example.com
docker exec <container> /music-practice -reset-password someone@example.com
```

(Those are for a local container; for production see "Deploying" below.)

## How it fits together

Go serves the pages and the static files, and holds accounts and synced history in SQLite.
Everything a visitor does while practising happens in the browser, in TypeScript that Deno bundles.

```
main.go                     server wiring, graceful shutdown, -dev / -migrate-status flags
usercmd.go                  -add-admin and -reset-password (bootstrap and lockout recovery)
cleanup.go                  daily backup (sqlitekit Backups), expired-session sweep
internal/config/            environment → one Config struct
internal/db/                SQLite open (sqlitekit settings and check), embedded goose migrations (adopting pre-goose databases)
internal/auth/              argon2id passwords, generated passwords, session tokens
internal/account/           users and their signed-in sessions; the last-admin guard
internal/history/           synced practice runs: push, pull by cursor, tombstones
internal/middleware/        security headers (CSP, Permissions-Policy: midi=(self)), access log (rate limits and client IP: github.com/17xande-dev/ratelimit)
internal/handler/           pages, account + admin pages, the sync API, static assets (go:embed'ed)
  templates/                layout + one template set per page
  static/styles.css         the theme (custom properties, light and dark)
  static/dist/              Deno output — build artefact, not committed
frontend/
  practice.ts songs.ts progress.ts   the page controllers (bundle entry points)
  lib/theory.ts             spelled notes, scale definitions, the step sequence
  lib/engine.ts             grading: NotesEngine and TempoEngine (pure, no DOM)
  lib/midi.ts               Web MIDI input, hot-plug
  lib/qwerty.ts             computer-keyboard fallback + a small synth
  lib/metronome.ts          clicks scheduled on the audio clock
  lib/keyboard_view.ts      SVG piano
  lib/circle_view.ts        circle-of-fifths key picker (SVG)
  lib/fft.ts lib/pitch.ts   radix-2 FFT and MPM pitch detector (ported from pitchy, MIT)
  lib/note_tracker.ts       pitch frames → note on/off events (onsets, stability, gate)
  lib/audio_input.ts        guitar audio input: device choice, worklet, tracker, tuner
  lib/guitar.ts             tuning, position boxes, fingering layout
  lib/fingering.ts          finger numbers: piano scale fingering, guitar finger-per-fret
  lib/score.ts              songs: events, tempo map, selections → Steps, per-measure stats
  lib/score_view.ts         songs: OpenSheetMusicDisplay rendering, cursor walk, note marks
  lib/song_player.ts        songs: count-in, metronome, accompaniment and listen playback
  lib/song_library.ts       songs: uploaded scores in IndexedDB, file checks
  lib/song_session.ts       songs: history records, validation, bests
  lib/calibration.ts        latency calibration: tap matching and the click run
  lib/share_url.ts          scale exercises ⇄ query strings
  lib/pwa.ts lib/sw_assets.ts  service worker registration, precache list
  sw.ts                     the service worker (bundle; served at /sw.js with a version)
  lib/fretboard_view.ts     SVG fretboard (guitar's counterpart to the keyboard)
  lib/pluck.ts              synthetic plucked notes for tests and the test hook
  pitch_worklet.ts          AudioWorklet: runs the detector every ~5 ms (third bundle)
  lib/staff_view.ts         VexFlow staff / grand staff
  lib/timing_chart.ts       per-note timing chart (tempo results)
  lib/accuracy_chart.ts     accuracy trend (progress page)
  lib/input_source.ts       midi vs on-screen input of a run (the `input` field)
  lib/progress_store.ts     localStorage history + settings, export/import, sync queue
  lib/sync.ts               history sync with the server (docs/sync-api.md)
  lib/*_test.ts             Deno tests
```

Deno bundles only the TypeScript entry points, not HTML, because the pages are Go templates. Without
code-splitting the bundle names stay fixed (`dist/practice.js`, `dist/progress.js`), and Go's
`{{asset}}` adds a content hash to each URL, so assets are cached `immutable` and a rebuild
invalidates them. A binary built without the bundle refuses to start instead of serving pages whose
scripts 404.

**Timing.** MIDI events carry `performance.now()` timestamps from when they arrived. Metronome
clicks are scheduled on the Web Audio clock, and `getOutputTimestamp()` maps them to the same
`performance.now()` timeline at the moment they are _heard_. The grading therefore compares like
with like; setTimeout would drift by about as much as it measures. The latency offset covers what's
left, mainly the instrument's own delay.

**Why no framework.** The UI is a handful of forms and two SVG views driven by one state machine per
page. Plain DOM code keeps the bundle to VexFlow plus a few kilobytes and keeps the CSP simple.

### Accounts and sync

Accounts exist only to sync practice history between a person's browsers and the iPad app; every
page works without one. There is no sign-up: an admin creates each account at `/admin/users`, which
generates a password and shows it once, and the person changes it at `/account`. The first admin
comes from `-add-admin` (see Develop).

Both apps stay local-first: the device's own history is the source of truth and works offline. The
server stores each run as the app's JSON and swaps runs between a user's devices through
`POST /api/sync`: a union by id, deletions as tombstones, and a cursor so each sync asks only for
what is new. [`docs/sync-api.md`](docs/sync-api.md) is the contract; the iPad app syncs too
([`docs/ipad-sync-handoff.md`](docs/ipad-sync-handoff.md) has the design notes). Settings and
uploaded scores are not synced.

Browsers authenticate with a session cookie (30 days idle, 90 days absolute by default); the
app uses a bearer token from `POST /api/token` (90 days idle, 365 days absolute by default).
Both are opaque random tokens stored only as their SHA-256 hash. The account page lists live
sessions and lets their owner sign them out.

### Dependencies

The server is stdlib apart from:

| Dependency                    | Why                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modernc.org/sqlite` | The SQLite driver for accounts and synced history. Pure Go, so the Docker build needs no C toolchain (`CGO_ENABLED=0`) and the runtime stays `distroless/static`. Chosen over `mattn/go-sqlite3` (the C original, faster) for that cgo cost; the speed difference does not matter at this size, and the file format is the same. |
| `github.com/17xande-dev/sqlitekit` | The shared SQLite standard: the connection string (foreign keys, WAL, busy timeout, immediate transactions), the startup check that they took effect, goose on STRICT tables and the dated backups. |
| `github.com/pressly/goose/v3` | Runs the migrations (through sqlitekit's `goosestrict`). The shared house choice for every app's schema history; it replaces the small `user_version` runner this app had. |
| `golang.org/x/crypto`         | argon2id password hashing (`x/crypto/argon2`). Security-sensitive, so a widely reviewed implementation from the Go team rather than anything hand-rolled; it brings `golang.org/x/sys` with it.                                                                                                                                                   |
| `golang.org/x/time`           | `rate`, the token bucket behind the sign-in and password-change limits. From the Go team, and small.                                                                                                                                                                                                                                              |

One SQLite file holds every user, not a file per user: the sign-in lookup needs a shared table
anyway, and one file means one migration run and one backup. Postgres would be the choice the day a
second instance runs (or a rolling deploy overlaps two), since two processes cannot share a SQLite
file.

The frontend has two runtime dependencies:

| Dependency                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm:vexflow@5.0.0`               | Staff notation. Clefs, key signatures, accidentals (including the naturals melodic minor needs), ledger lines and beaming are fiddly to get right by hand. Pinned exactly because rendering depends on its layout internals. Imported via `vexflow/bravura`, which embeds its fonts as data: URIs; the default build would fetch them from a CDN.                                                                                                                                                                                                                                                                                                                         |
| `npm:opensheetmusicdisplay@2.1.3` | Song scores. Renders MusicXML and `.mxl` (it unzips them itself) and walks the piece with a cursor that plays out repeats and reports pitch, staff, ties, fingering and tempo. BSD-3-Clause. Chosen over Verovio, whose WebAssembly build is ~7× larger and needs `'wasm-unsafe-eval'` plus a workaround for the `<style>` blocks in its SVG, both at odds with the CSP. It carries its own VexFlow 1.x and JSZip, and lives only in the songs bundle. Its cursor is an `<img>` with a `data:` URL, so it is never shown; the page marks notes by class instead. Its `drawFingerings` option can't turn fingerings back on, so the page sets the engraving rule directly. |
| `jsr:@std/assert` (test only)     | Assertions for `deno test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Deno supplies the bundler, type checker, linter, formatter and test runner. There is no npm project
and no Node toolchain.

### Security

- The CSP is a fixed constant pinned by a test: `default-src 'self'`, `script-src 'self'`,
  `style-src 'self'`, and no `unsafe-inline` or `unsafe-eval` anywhere. `font-src` and `img-src`
  allow `data:` for VexFlow's embedded fonts.
- No served template contains an inline style, event handler or script. A test walks every page to
  enforce this, because the CSP would silently refuse them and handler tests never run JavaScript.
- `Permissions-Policy` grants `midi` and `microphone` (for guitar) to this origin only.
- The static route serves only listed file extensions.
- Nothing about a signed-out visitor reaches the server. History stays in their browser, and
  imported files are validated and rebuilt field by field before storage.
- Signed in, practice runs are stored on the server per account. Passwords are argon2id. A failed
  sign-in looks the same and costs the same whether the email exists or not. Sign-in, the app's
  token endpoint and the change-password form are rate-limited. The session cookie is HttpOnly,
  Secure and SameSite=Lax, and every state-changing request passes the stdlib's cross-origin check,
  which is the CSRF defence for the forms and the API alike. Hardening on top: form bodies are
  capped (4 KB, 8 KB for the password form); a malformed or over-254-byte email is refused before
  the limiter, which is keyed on the sha256 of the normalised email, with IPv6 clients sharing a
  per-/64 IP bucket; at most three argon2 computations run at once process-wide (a fourth waits 2 s,
  then gets 503 with Retry-After, and the container has a 512 MB memory limit); failed sign-ins and
  limit hits are logged with an email hash prefix and the client IP; signing in over a live session
  revokes it; the post-sign-in `next` must be a plain same-site path.
- Sync: `POST /api/sync` takes an optional `account` and answers 409 on a mismatch (a shared browser
  cannot push one person's history into another's account), caps a push at 1000 records and 1000
  deletions, and pages pulls by bytes as well as count. The web client batches by size and halves on
  413; the signed-out page clears the browser's sync state.
- The page shells never contain who is signed in: the service worker caches them, and a cached page
  must not show the last person's email. Only `/account`, `/admin` and `/api` look up the session,
  and they are `no-store`. Everything under `/admin` is also `noindex`, and answers a signed-in
  non-admin with a plain 404.

There are no `STATIC_DIR` or `TEMPLATE_DIR` overrides: this is a single deployment, not a project
for others to reskin.

## Licence

MIT, see [LICENSE](LICENSE). The site ships third-party code and fonts under their own licences
(MIT, BSD-3-Clause, and the SIL Open Font License for VexFlow's Bravura and Academico fonts). Their
full texts and copyright notices are served at `/static/licenses.txt`, linked from the About page,
and a test keeps them published. When a dependency is added or upgraded, update
`internal/handler/static/licenses.txt` and the credits in `templates/about.html`.

## Testing

`make check` is the gate before any commit:

- **Deno:** scale spelling across every tonic × type × octave count; fingering against the standard
  tables, plus a playability check over every scale, key and length; the grading engines driven by
  synthetic note streams (wrong notes, repeats, hands-together asynchrony, early/late/missed,
  latency offset, fast subdivisions, unevenly timed song steps); the song score model (ties,
  repeats, tempo changes, hand selections, part choice, per-measure stats) and playback plans; song
  file checks; MIDI parsing; the computer-keyboard octave choice; metronome timing; staff clef and
  key helpers; chart ranges; and the progress store against in-memory, full and throwing storage,
  including hostile imports.
- **Go:** routes, the pinned security headers, the static extension gate, content-hashed asset URLs,
  the missing-bundle boot failure, and the no-inline-content rule.

The browser is the other half. UI changes are checked in Chrome through the DevTools MCP server, at
desktop and phone widths and in light and dark themes, with the console open for CSP violations.
DevTools can't provide a MIDI device, so the practice page exposes
`window.__practice.note(midi, on, t)`, which feeds a note through the same path a MIDI message
takes. The songs page has `window.__songs` for the same purpose, and real scores (Clementi, Bach,
Schumann `.mxl`, a Beethoven song with voice and piano) are checked by uploading them through the
file input. A real instrument still needs a human.

## Deploying

Live at **https://music.17xande.dev**, deployed with [Kamal](https://kamal-deploy.org)
(`config/deploy.yml`). The host (`home-docker`) runs kamal-proxy with nothing published, behind one
shared Cloudflare tunnel; that host-side setup lives in `~/dev/17xande.dev/infra`. The tunnel's
public hostname `music.17xande.dev` has service `http://kamal-proxy:80`, and kamal-proxy routes by
host to the app (port 8080, health check `/healthz`, which is unauthenticated). Cloudflare
terminates TLS, so Kamal runs with `proxy.ssl: false`. Nothing else can reach the app, which is what
makes trusting `CF-Connecting-IP` safe. The app runs with a 512 MB limit and the named volume
`music-practice-data` at `/data`.

`HSTS=1` sends Strict-Transport-Security. Set `COOKIE_SECURE=1` and
`BASE_URL=https://music.17xande.dev`: the browser sees HTTPS even though the app sees plain HTTP
from kamal-proxy. The first release using `__Host-mp_session` signs browser users out once; the
cookie rename does not affect iPad tokens. Session limits also apply to existing rows and count
from the recorded sign-in and last use, not from the deploy. Browser history stays local, but any not-yet-sent
deletions are discarded when sync sees the old cookie rejected. Rolling back across the cookie
rename signs browsers out again. It also changes iPad sessions: the new release
writes a derived `expires_at` on every device row, and the older release reads any non-empty
`expires_at` as a sliding 90-day web expiry. After a rollback an iPad unused for about 90 days is
therefore signed out, which never happened before; one used at least every 90 days is not.

### Cross-origin requests and offline sync

Go's `http.CrossOriginProtection` wraps the entire router. For state-changing requests
it uses `Sec-Fetch-Site` first, then falls back to comparing `Origin` with the request
`Host`. The validated `BASE_URL`, when set, is an exact trusted origin so a proxy
rewriting `Host` does not break browser requests. Refusals are non-cacheable 403s
(JSON under `/api/`); the warning records the method, registered route pattern
(or an unmatched marker), and which header caused the refusal, not the URL or header values.

Requests with neither header still pass the origin check: this is how the native
iPad client works, and it still needs to authenticate. For a browser that sends
neither header, the session cookie's `SameSite=Lax` is the backstop; the server
does not require a separate form token. A request with any
`Authorization` header that is not exactly one well-formed `Bearer <token>` (empty, `Basic`,
repeated) is rejected rather than falling back to a browser session.

The service worker stores only the public, cookie-independent shells (`/`,
`/songs`, `/progress`, `/about`) and static assets. It doesn't cache account or
admin pages or intercept API requests or non-GET requests. Tests exercise the
worker's cache decisions, compare the served shells with and without a session,
and check that a cookie-authenticated `POST /api/sync` with
`Sec-Fetch-Site: same-origin` succeeds. To verify browser behavior end to end,
sign in on a worksheet page, trigger a sync and inspect the request and response
in DevTools. Then go offline under worker control and verify that a public
shell loads from Cache Storage and no private account, admin or API response
is stored there. The tests do not run that full browser flow.

```sh
make deploy                        # check gate, then kamal deploy (build, push to ghcr.io, swap in)
kamal rollback <version>           # back to an earlier image; `kamal app version` / `kamal app containers` list them
make logs-prod                     # kamal app logs -f
```

`make deploy` refuses uncommitted tracked changes, since Kamal builds from `HEAD`. Registry login is
`gh auth token` (see `.kamal/secrets`). The app has no secrets of its own.

The database lives at `/data/music-practice.db` on that volume. This is a new host, so the volume
starts fresh: the old Coolify box's database is not carried over. The image creates `/data` owned by
the nonroot user it runs as (uid 65532), which Docker copies into a fresh volume, so the server can
write it without root. At startup and daily after that (from the same loop that sweeps expired sessions), it writes a
`VACUUM INTO` backup to `/data/backups/music-practice-YYYYMMDD.db` (UTC date; one per day, mode 0600,
in a folder only the app uses) and keeps the newest seven, via sqlitekit's `Backups`. A backup is an
ordinary, complete database file, consistent while the app writes. A leftover
`music-practice-*.partial` from the previous backup code is deleted once at startup. Backups cover a
bad migration or a mistaken delete, not losing the volume (see "Decisions still open").

While it runs the database is three files: `music-practice.db`, `music-practice.db-wal` and
`music-practice.db-shm` (it runs in WAL mode). Never copy the `.db` of a running app (`cp`,
`docker cp`, a tar of the volume): recent commits live in the `-wal` file and the copy can be torn.
Take a `VACUUM INTO` copy (the daily backups are exactly that) or stop the app first.
A fourth file, `music-practice.db.migrate-lock`, sits beside the database: it serialises migrations
between processes that open it at the same time (it is released when a process exits). It is
created on first open and never deleted, so leave it alone while the app runs. Run migrating
commands as the image user (e.g. through `kamal app exec`), never as root: every open takes
`music-practice.db.migrate-lock` read-write, so a root-created (0600) lock file stops the app
starting on its next restart, and makes the status command and the cmd tools fail with permission
denied.

Operating production (run from this repo; `kamal` as above). Only the `kamal app logs` form is
exercised by `make logs-prod`; the rest are reasoned from Kamal's and the image's behaviour and
**untested**:

```sh
# First admin (after the first deploy), or a lockout reset. --reuse execs in
# the running container. Without it Kamal starts a fresh container, and the
# image's ENTRYPOINT (/music-practice) would be prefixed to the command,
# starting a second server. The whole command is ONE quoted argument.
kamal app exec -i --reuse "/music-practice -add-admin you@example.com"
kamal app exec -i --reuse "/music-practice -reset-password someone@example.com"

# Logs
kamal app logs -f            # or: kamal app logs --since 1h
```

Backups and restore. The image has no shell or tar, so the volume is read from a throwaway container
**on home-docker** (`ssh ubuntu@home-docker`; every `docker run` below runs there, the `kamal` lines
run from this repo on your laptop):

```sh
# ON home-docker: list the backups, and copy one out
docker run --rm -v music-practice-data:/data busybox ls -l /data/backups
docker run --rm -v music-practice-data:/data -v "$PWD":/out busybox cp /data/backups/<file>.db /out/

# Before a deploy: take a backup, because the daily one may predate the change
# and a deploy that runs a migration cannot be undone by rolling the image back.
# The image has no shell or sqlite3, so use a throwaway alpine container ON
# home-docker. The backup runs as uid 65532 (a root read of a WAL database that
# is not running would leave root-owned -wal/-shm files the app cannot use).
# `.timeout 5000` waits out a write in progress; the last line must print `ok`.
docker run --rm -v music-practice-data:/data alpine:3 sh -c '
  set -e
  apk add --no-cache sqlite >/dev/null
  adduser -D -H -u 65532 app
  su -s /bin/sh app -c "sqlite3 -bail -cmd \".timeout 5000\" /data/music-practice.db \".backup /data/music-practice-pre-deploy.db\""
  chmod 600 /data/music-practice-pre-deploy.db
  su -s /bin/sh app -c "sqlite3 -readonly /data/music-practice-pre-deploy.db \"PRAGMA integrity_check\""'
# It overwrites an earlier music-practice-pre-deploy.db and is not pruned; delete it once the deploy is confirmed.

# Restore. First verify the copy BEFORE touching anything: the file must exist,
# be non-empty, and pass SQLite's own check (ON home-docker, in the directory
# holding <file>.db; the image has no sqlite3, so use one that does):
ls -l <file>.db
docker run --rm -v "$PWD":/in alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 /in/<file>.db "PRAGMA integrity_check"'   # want: ok

# Only then replace the live database. It overwrites it, so stop the app and
# copy the CURRENT database out first (the pre-restore copy, with its -wal/-shm
# files). The files must end up owned by uid 65532.
kamal app stop                     # laptop
docker run --rm -v music-practice-data:/data -v "$PWD":/out busybox \
  sh -c 'cp /data/music-practice.db* /out/'   # ON home-docker: the pre-restore copy
docker run --rm -v music-practice-data:/data -v "$PWD":/in busybox \
  sh -c 'cp /in/<file>.db /data/music-practice.db && rm -f /data/music-practice.db-wal /data/music-practice.db-shm && chown 65532:65532 /data/music-practice.db'   # ON home-docker
kamal app boot                     # laptop
```

Cloudflare settings for the hostname: the tunnel's public hostname points at
`http://kamal-proxy:80`. Do not set an `httpHostHeader` override: the cross-origin check compares
`Origin` with the request's `Host`, so rewriting `Host` breaks every sign-in and sync POST.
Also turn off Email Obfuscation and Rocket Loader for this hostname (a Configuration Rule, or
Speed and Scrape Shield): both rewrite served pages and scripts, which the strict CSP then refuses.

The runtime image is distroless (no shell, no `wget`), so Docker health is not used: kamal-proxy
checks `/healthz` over HTTP and only routes to a container that answers. The binary's own
`music-practice -healthcheck` probe remains for `docker exec`.

## Roadmap

Planned, not built yet. Each entry notes how it would fit what exists, so it can be picked up
without re-deriving the design.

**Practice and learning**

- **Practice routine.** Turn the history into guidance: suggest scales not played lately or with the
  lowest recent accuracy, the weakest measures of each song (from the stored per-measure results),
  and a daily set ("10 minutes: two scales, one passage"), with a streak and a goal. Pure logic over
  `ProgressStore` sessions and song sessions; a "Today" panel on the Progress page.
- **Sight-reading exercises.** Generate short melodies in a key at a chosen difficulty (range,
  intervals, rhythms, accidentals), shown on the VexFlow staff and graded by the existing engines.
  The generator should be seeded so a melody can be shared by URL (see the share-link format).
- **Ear training.** The app plays an interval, chord or short phrase with the synth and the player
  answers on the instrument; graded by pitch class or exact pitch. Reuses `Synth`/`SongPlayer`, the
  MIDI and guitar inputs, and the engines' note matching.
- **Diatonic chord drills, contrary motion, scales in thirds and sixths.** The chord path
  (`chordSteps`, block-chord fingering, multi-note staff) already exists for triad inversions.
- **Help page.** Connecting MIDI and a guitar interface, what each grade means, calibration, and how
  to export MusicXML from MuseScore and other editors. A static template like About.

**Songs**

- **Speed trainer:** start a passage slow and raise the tempo after each clean loop, up to a target.
- **Guitar melody mode:** grade one line of a score through the guitar pitch tracker (part or voice
  choice, monophonic).
- **MIDI file import,** with quantisation and a clear "approximate notation" label.
- **Transposition,** and **links for song practice options** (hands, measures, mode, tempo) so a
  passage of your own song can be bookmarked.
- **Pickup measures** numbered as printed (positions are counted from 1 today, so a score starting
  with an upbeat is one off).

**Stage 2: accounts**

- ~~Accounts and server-side history (SQLite).~~ Done for the web and the iPad app, see "Accounts
  and sync".
- **Sharing songs by link,** which needs scores stored on the server, and history across devices.
- **Teacher view:** assign exercises and passages, see students' results and heat maps.

**Decisions still open**

| Decision                    | Current choice                                      | What would change it                                                                                                                                               |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Off-box backups             | None: daily `VACUUM INTO` copies on the same volume | Any data someone would miss. Options: Litestream to object storage (another process in the image), or a cron job on home-docker copying `/data/backups` off the host. |
| Self-service sign-up        | None; the admin creates accounts                    | More users than an admin wants to type in. Needs email verification, so an email provider.                                                                         |
| Password reset by email     | None; an admin resets it and passes it on           | Same trigger and same email provider as sign-up.                                                                                                                   |
| Syncing settings and scores | Not synced                                          | People practising the same song on two devices. Scores need blob storage and size limits; settings need last-writer-wins per field.                                |
| SQLite → Postgres           | SQLite, one file for every user                     | A second app instance, or overlapping (blue/green) deploys: two processes cannot share the file.                                                                   |

**Guitar and audio research**

- Learn each string's sound (calibration) to guess string and fret.
- An ML pitch engine (CREPE/SPICE) and ML fret-position estimation, if MPM struggles with real-world
  signals.
- Acoustic instruments through a microphone (more noise and room sound).
