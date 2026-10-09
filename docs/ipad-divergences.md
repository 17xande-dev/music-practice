# Fixes to bring over from the iPad app

The iPad app (music-practice-app, with its ScoreKit library) was ported from this web app.
In a few places it deliberately behaves differently, because the web behaviour here is a
bug or a poor experience. Each item below is a fix the web app should adopt so the two match again.
When one is done, also update the parity fixtures
(`deno task score-fixtures`) and remove the matching "known divergence" from
ScoreKit's `TimelineParityTests` / MusicCore's `SongParityTests`.

## Playback order and tempo (OSMD 2.1.3 bugs)

The web gets these from OSMD's cursor walk (`frontend/lib/score_walk.ts`). Fixing them
means post-processing the walk, or building the timeline ourselves, rather than trusting
`cursor.iterator`. Evidence for each is in `frontend/lib/testdata/fixtures/README.md`
("OSMD probes"). ScoreKit's behaviour is in `ScoreKit/Sources/ScoreKit/Timeline/`.

- [ ] **`<repeat times="N">` is ignored.** OSMD always plays a repeat twice
  (`RepetitionInstruction.Times` is never read). Fix: honour `times`.
  ScoreKit caps it at 16. Fixture: `repeat-times-3`.
- [ ] **Ending numbers keep only the first digit.** `number="1, 2"` becomes `[1]`. Fix:
  parse comma lists and ranges, so a repeat with endings "1, 2" then "3" plays
  1 2 1 2 1 3 4. Fixture: `ending-multi-number`.
- [ ] **Ending text overrides the `number` attribute.** "First time"/"Second time" with
  no digits stops measures from playing, and swapped digits play the piece twice. Fix:
  `number` governs; text is only the label. Fixtures: `ending-text-differs`,
  `ending-text-digits-swapped`.
- [ ] **A hidden ending (`print-object="no"`) is skipped entirely.** Fix: it still plays;
  only the bracket is hidden. Fixture: `ending-print-object-no`.
- [ ] **Tempo `<offset>`.** A direction's offset applies only at a measure start, and a
  mid-measure tempo with an offset never takes effect. Fix: follow the MusicXML spec. A
  direction's `<offset>` affects playback only with `sound="yes"`; `<sound><offset>`
  always does. Fixtures: `tempo-offset`, `tempo-offset-mid-measure`.
- [ ] **An invalid `tempo="fast"` resets to 100, and `tempo="0"` gives 60.** Fix:
  ignore invalid or zero values and keep the current tempo. Fixture: `sound-decimal-tempo`.
- [ ] **Ties are resolved in score order, not playback order.** A tie before `:|`
  claims the note after the volta, and a tie into ending 2 is lost. Fix: resolve ties
  over the unrolled sequence (a tie only joins the next played measure).
- [ ] *(Optional, musical)* **Metronome beat unit and dots are ignored.** "half = 60"
  plays as 60 quarters per minute. ScoreKit currently matches OSMD here
  (`Metronome.quarterBPM` holds the correct value). Decide whether both should switch.

## Songs page behaviour (`frontend/songs.ts`, `frontend/lib/score.ts`)

- [ ] **A measure range inside a repeated section plays every pass with dead time between them.**
  `practiceSteps` filters by written measure number, so range 9–9 in the Minuet plays
  m9, about 15 silent measures (with metronome clicks), then m9 again. iPad: a range
  plays each selected measure once, continuously, using the first pass. The whole piece keeps
  its repeats. Per-measure stats still key on the written measure.
- [ ] **Metronome in Listen mode.** The web forces it off and hides the checkbox. iPad:
  Listen follows the user's metronome option.
- [ ] **Tap to seek during a repeat goes to the first pass** (`findIndex`). iPad: picks
  the pass nearest the current step, so a tap stays in the current pass.
- [ ] **Tap to seek on a rest, on a note of the hand not being practised, or on a
  tie-only position goes to step 0.** `stepOfRef`'s fallback searches `p.events`
  again, so it is dead code. iPad: seeks to the first step at or after the note's beat
  (`stepOfRef` + `stepOfPosition`).
- [ ] **Changing tempo while playing resets to step 0** (`rebuild()` → `reset()`).
  iPad: Listen, Learn and Notes continue from the current step at the new tempo. In Tempo
  and Rubato modes a tempo change starts a fresh run from the current step, with a new
  count-in, so a saved session always has one tempo. In Tempo mode, toggling the metronome
  or the other hand mid-run replays from the current step with a count-in and keeps the
  grades so far.

- [ ] **Seeking after a finished Learn/Notes run keeps the old run.** The web never
  sets `phase = "done"` in wait modes, so a prev/next measure or tap after finishing
  keeps `attempted` and the marks, and the next `finishRun` saves a second, inflated
  session merging both runs. iPad: a seek after a finished run clears it and starts
  fresh. The results card can also be dismissed.
- [ ] **A Tempo run ends when the last timing window closes and cuts off the sound**
  (`e.done` → `player.stop()`), so a long final note or held accompaniment chord is
  clipped. iPad: the run ends once the last window has closed and the audio has played
  out, so the results card appears after the final note finishes sounding.

## Shared quirks to fix in both apps

- [ ] **Accompaniment in wait modes only sounds other-hand notes that coincide with a
  practised step** (`beat - from < 0.01`). Notes between steps, or under a rest in the
  practised hand, never sound, even though the comment says "up to the next step".
- [ ] **A note followed by an immediate reset logs a 0 ms Learn entry.** Drop
  `ms == 0` entries.

## Not divergences, but worth knowing

- The cursor band is centred on the notehead on iPad. The web's band starts 1.5 units
  left of the staff entry, as OSMD places it.
- ScoreKit draws the line view without a sticky clef or key signature, as the web
  does. It's on the iPad polish backlog.
