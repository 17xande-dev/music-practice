# Upstream bugs: OSMD and VexFlow

These are bugs in the libraries the web app draws scores with:
- OpenSheetMusicDisplay (`npm:opensheetmusicdisplay@2.1.3`)
- VexFlow (`npm:vexflow@5.0.0`)

They were found while porting the app to iPad and while fixing the web app. Each entry
has enough detail for a later session to reproduce the bug, check it against the
upstream trackers, and open an issue or a pull request:
- https://github.com/opensheetmusicdisplay/opensheetmusicdisplay
- https://github.com/vexflow/vexflow

App-level workarounds and iPad behaviour are tracked separately, in `ipad-divergences.md`.

## Entry format

```
### <library> <version>: <one-line symptom>
- Status: found | confirmed on latest | reported #N | PR #N | fixed in <version>
- Repro: a fixture path or a minimal MusicXML snippet, and the observed vs expected result
- Cause: the source file and function, if known
- Fix: the proposed change, and any test to add upstream
- Upstream: links to any existing issues or PRs (search before filing)
- Workaround: what the web app or ScoreKit does meanwhile
```

Before reporting, re-check the bug against the library's latest release and main
branch. Upstream may already have fixed it.

## OSMD 2.1.3

The evidence for the playback entries is in `frontend/lib/testdata/fixtures/README.md`
("OSMD probes"), with fixtures under `frontend/lib/testdata/fixtures/`.

### OSMD 2.1.3: `<repeat times="N">` is ignored; a repeat always plays twice
- Status: found
- Repro: fixture `repeat-times-3`. A repeat with `times="3"` plays twice.
- Cause: `RepetitionInstruction.Times` is never read by the cursor or iterator walk.
- Fix: honour `times` when unrolling.
- Workaround: ScoreKit honours `times`, capped at 16. The web plays it twice.

### OSMD 2.1.3: ending numbers keep only the first digit
- Status: found
- Repro: fixture `ending-multi-number`. `number="1, 2"` becomes `[1]`, so a repeat with
  endings "1, 2" then "3" does not play 1 2 1 2 1 3 4.
- Cause: the ending-number parsing (find it in the volta/ending reader).
- Fix: parse comma-separated lists and ranges, as the MusicXML spec allows.
- Workaround: ScoreKit parses lists.

### OSMD 2.1.3: ending text overrides the `number` attribute
- Status: found
- Repro: fixtures `ending-text-differs` and `ending-text-digits-swapped`. With text
  "First time" and no digits, the measures never play; with swapped digits, the piece
  plays twice.
- Fix: `number` governs which pass plays the ending; the text is only a label.

### OSMD 2.1.3: a hidden ending (`print-object="no"`) is skipped in playback
- Status: found
- Repro: fixture `ending-print-object-no`.
- Fix: a hidden ending still plays; only its bracket is hidden.

### OSMD 2.1.3: a tempo direction's `<offset>` only applies at a measure start
- Status: found
- Repro: fixtures `tempo-offset` and `tempo-offset-mid-measure`. A mid-measure tempo with
  an offset never takes effect.
- Fix: follow the spec. A direction's `<offset>` affects playback only with
  `sound="yes"`; `<sound><offset>` always does.

### OSMD 2.1.3: an invalid `tempo="fast"` resets to 100, and `tempo="0"` gives 60
- Status: found
- Repro: fixture `sound-decimal-tempo`.
- Fix: ignore invalid or zero values and keep the current tempo.

### OSMD 2.1.3: ties are resolved in score order, not playback order
- Status: found
- Repro: a tie before `:|` claims the note after the volta, and a tie into ending 2 is
  lost.
- Fix: resolve ties over the unrolled sequence, so a tie only joins the next measure
  that is actually played.

### OSMD 2.1.3: the metronome beat unit and dots are ignored (questionable, not a clear bug)
- Status: found
- Repro: "half = 60" plays as 60 quarter notes per minute.
- Fix: scale the tempo by the beat unit and its dots. Check upstream's intent first.

## VexFlow 5.0.0

(None recorded yet.)
