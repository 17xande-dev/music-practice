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
- **Progress:** stage 1 has no accounts. Every run is saved in your browser's localStorage, and the
  Progress page shows trends, per-scale bests and recent sessions. History can be exported and
  imported as JSON.
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
  your browser (IndexedDB), never uploaded. Three modes: _wait for each note_ (the cursor holds
  until you play the right notes), _play in time_ (a count-in and a metronome that follows the
  score's tempo marks; wrong, missed, early and late notes are graded), and _listen_ (the app plays
  it). Each mode covers both hands or one, with the other hand optionally played for you, a range of
  measures, and a tempo as a percentage of the marked one, and can repeat the selection. Repeats in
  the score are played out. After a run, a heat map shows each measure from clean to troubled;
  clicking a measure, or "practise the weakest measures", sets up that passage. Fingering printed in
  the file shows with "Show fingers". A piano written as one two-staff part or as separate
  right/left-hand parts is graded as two hands; in a voice-and-piano song, the piano part is graded.
- **Shareable links:** the scales page keeps its address in step with the exercise on screen, e.g.
  `/?instrument=piano&key=F%23&scale=harmonic-minor&hands=both&octaves=2&dir=updown&mode=tempo&bpm=90&beat=2`,
  and "Copy link" copies it. Opening a link sets that exercise up; anything it leaves out keeps your
  own setting. Device-specific settings (MIDI device, latency offset, tuning reference) aren't
  shared. Parameters: `instrument` (piano, guitar), `key` (C, F#, Bb…), `scale` (major,
  natural-minor, harmonic-minor, melodic-minor, dorian, phrygian, lydian, mixolydian, locrian,
  major-pentatonic, minor-pentatonic, blues, chromatic), `hands` (rh, lh, both), `position` (guitar,
  0–12), `octaves` (1–4), `dir` (up, updown), `mode` (notes, tempo), `bpm` (40–200), `beat` (notes
  per beat: 1, 2, 4), `fingers` (1 or 0).
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

| Keys                    | Scales page                                            | Songs page                                   |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `Space`                 | Start / stop (metronome mode); start over (notes only) | Play / pause                                 |
| `R`                     | Restart                                                | Restart from the beginning                   |
| `Esc`                   | Stop                                                   | Stop, and leave the big screen               |
| `←` `→`                 |                                                        | Previous / next measure (hold to keep going) |
| `Home`                  |                                                        | Go to the start                              |
| `Alt+F`                 |                                                        | Big screen                                   |
| `Alt+V`                 |                                                        | Continuous / page view                       |
| `Alt+=` `Alt+−`         |                                                        | Bigger / smaller notes                       |
| `Alt+L`                 |                                                        | Repeat the selection on / off                |
| `Alt+M`                 |                                                        | Metronome on / off                           |
| `Alt+N`                 | Show / hide fingers                                    | Show / hide fingers                          |
| `Alt+B`                 | Music sheet light / dark                               | Music sheet light / dark                     |
| `Alt+C`                 | Copy link to the exercise                              |                                              |
| `Alt+T`                 | Light / dark theme                                     | Light / dark theme                           |
| `Alt+1` `Alt+2` `Alt+3` | Go to Scales / Songs / Progress                        | Go to Scales / Songs / Progress              |
| `Ctrl+K`                | Command palette                                        | Command palette                              |
| `?`                     | Keyboard shortcuts                                     | Keyboard shortcuts                           |

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
  lib/progress_store.ts     localStorage history + settings, export/import
  lib/*_test.ts             Deno tests
```

Deno bundles only the TypeScript entry points, not HTML, because the pages are Go templates. Stage 2
needs server-rendered pages for signed-in users. Without code-splitting the bundle names stay fixed
(`dist/practice.js`, `dist/progress.js`), and Go's `{{asset}}` adds a content hash to each URL, so
assets are cached `immutable` and a rebuild invalidates them. A binary built without the bundle
refuses to start instead of serving pages whose scripts 404.

**Timing.** MIDI events carry `performance.now()` timestamps from when they arrived. Metronome
clicks are scheduled on the Web Audio clock, and `getOutputTimestamp()` maps them to the same
`performance.now()` timeline at the moment they are _heard_. The grading therefore compares like
with like; setTimeout would drift by about as much as it measures. The latency offset covers what's
left, mainly the instrument's own delay.

**Why no framework.** The UI is a handful of forms and two SVG views driven by one state machine per
page. Plain DOM code keeps the bundle to VexFlow plus a few kilobytes and keeps the CSP simple.

### Dependencies

`go.mod` has none: the server is stdlib only. The frontend has two runtime dependencies:

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
- Nothing about a visitor reaches the server. History stays in their browser, and imported files are
  validated and rebuilt field by field before storage.

There are no `STATIC_DIR` or `TEMPLATE_DIR` overrides: this is a single deployment, not a project
for others to reskin.

## Licence

MIT, see [LICENSE](LICENSE). The site ships third-party code and fonts under their own licences
(MIT, BSD-3-Clause, and the SIL Open Font License for VexFlow's Bravura and Academico fonts). Their
full texts and copyright notices are served at `/static/licenses.txt`, linked from the About page,
and a test keeps them published. When a dependency is added or upgraded, update
`internal/handler/static/licenses.txt` and the credits in `templates/about.html`.

## Testing

`make check` runs everything CI runs:

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

- Accounts and server-side history (SQLite). The localStorage export (`version: 1`, with
  `songSessions`) is the import path.
- **Sharing songs by link,** which needs scores stored on the server, and history across devices.
- **Teacher view:** assign exercises and passages, see students' results and heat maps.

**Guitar and audio research**

- Learn each string's sound (calibration) to guess string and fret.
- An ML pitch engine (CREPE/SPICE) and ML fret-position estimation, if MPM struggles with real-world
  signals.
- Acoustic instruments through a microphone (more noise and room sound).
