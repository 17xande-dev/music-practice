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

For what the web shows versus correct engraving, see the
[OSMD/VexFlow limitations survey](https://github.com/17xande/ScoreKit/blob/master/docs/osmd-vexflow-limitations.md)
(in ScoreKit).

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

Last checked 2026-10-09 against OSMD 2.2.0 (released 2026-10-02, npm) and the commit titles on
`develop` since then (69 commits). "Re-run on 2.2.0" means the fixture's walk was regenerated with
`opensheetmusicdisplay@2.2.0` in a scratch copy of the web repo and compared with 2.1.3. Nothing was
run against `develop`.

## OSMD 2.1.3

The evidence for the playback entries is in `frontend/lib/testdata/fixtures/README.md`
("OSMD probes"), with fixtures under `frontend/lib/testdata/fixtures/`.

### OSMD 2.1.3: `<repeat times="N">` is ignored; a repeat always plays twice
- Status: confirmed on latest (re-run on 2.2.0: same walk, measures 1 2 3 2 3 4)
- Repro: fixture `repeat-times-3`. A repeat with `times="3"` plays twice.
- Cause: `RepetitionInstruction.Times` is never read by the cursor or iterator walk.
- Fix: honour `times` when unrolling.
- Upstream: no issue or PR found searching the tracker for repeat/times (2026-10-09). The 2.2.0
  repetition fixes are all about D.C./D.S./Fine/endings, none about `times`.
- Workaround: ScoreKit honours `times`, capped at 16. The web plays it twice.

### OSMD 2.1.3: ending numbers keep only the first digit
- Status: confirmed on latest (re-run on 2.2.0: `ending-multi-number` still plays 1 2 1 3 4)
- Repro: fixture `ending-multi-number`. `number="1, 2"` becomes `[1]`, so a repeat with
  endings "1, 2" then "3" does not play 1 2 1 2 1 3 4.
- Cause: the ending-number parsing (find it in the volta/ending reader).
- Fix: parse comma-separated lists and ranges, as the MusicXML spec allows.
- Upstream: no issue found for list-valued `number`. Related, closed, about the drawn label
  only: https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/issues/1367
- Workaround: ScoreKit parses lists.

### OSMD 2.1.3: ending text overrides the `number` attribute
- Status: confirmed on latest (re-run on 2.2.0, see below)
- Repro: fixtures `ending-text-differs` and `ending-text-digits-swapped`. With text
  "First time" and no digits, the measures never play (1 4 1 4 in both 2.1.3 and 2.2.0).
  With swapped digits (`number="1"` labelled "2.", `number="2"` labelled "1."), 2.1.3 plays
  the piece twice; 2.2.0 plays it once as 1 2 1 2 3 4 (the number-1 ending on both passes), still
  not the expected 1 2 1 3 4.
- Fix: `number` governs which pass plays the ending; the text is only a label.
- Upstream: related only, no matching issue: closed
  https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/issues/1367 (label read from
  `<ending>`), merged https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1758
  (a first ending with no second ending plays on the first pass only; changed the swapped-digits
  result).
- Workaround: ScoreKit uses `number`, falling back to digits in the label only when `number` is missing. The web plays OSMD's walk.


### OSMD 2.1.3: a hidden ending (`print-object="no"`) is not played correctly
- Status: confirmed on latest (re-run on 2.2.0: same walk as 2.1.3)
- Repro: fixture `ending-print-object-no`. Observed 1 2 1 2 3 4 (the hidden ending 1 plays on
  both passes); expected 1 2 1 3 4.
- Fix: a hidden ending still plays on its own pass; only its bracket is hidden.
- Upstream: none found.
- Workaround: ScoreKit plays hidden endings. The web plays OSMD's walk.


### OSMD 2.1.3: a tempo direction's `<offset>` only applies at a measure start
- Status: fixed in 2.2.0 (observed by re-run; no changelog line names it)
- Repro: fixtures `tempo-offset` and `tempo-offset-mid-measure`. A mid-measure tempo with
  an offset never takes effect in 2.1.3. On 2.2.0 both now change tempo at the offset position
  (e.g. `tempo-offset-mid-measure`: 120 then 60 mid-measure 2 then 90 mid-measure 3).
- Fix: follow the spec. A direction's `<offset>` affects playback only with
  `sound="yes"`; `<sound><offset>` always does.
- Upstream: no issue found. Probably related, 2.2.0 changelog: "Keep marks at their beats without
  moving sound changes"
  https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1757 and "Keep a
  direction's placement, offset and sound values"
  https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1734. On `develop`, merged
  after 2.2.0 (dynamics and wedges only):
  https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1806
- Workaround: ScoreKit follows the spec. The web matches only after an upgrade to OSMD 2.2.0.
- Note: 2.2.0 also changed `sound-and-metronome-differ` (metronome 80 vs `sound tempo=120`): 2.1.3
  played 80, 2.2.0 plays 120, the `<sound>` value. Check the web fixtures when upgrading.

### OSMD 2.1.3: an invalid `tempo="fast"` resets to 100, and `tempo="0"` gives 60
- Status: confirmed on latest (re-run on 2.2.0), and worse for zero
- Repro: fixture `sound-decimal-tempo`. 2.1.3: `tempo="fast"` gives 100 and `tempo="0"` gives 60.
  2.2.0: `fast` still gives 100, and `tempo="0"` now gives a tempo of 0 (a zero BPM reaches
  the walk; a player dividing by it would break).
- Fix: ignore invalid or zero values and keep the current tempo.
- Upstream: none found. Related: https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1756
  (2.2.0, "Keep the current tempo at metronome marks without a BPM").
- Workaround: none known; check how the web player handles a zero tempo before upgrading to 2.2.0.

### OSMD 2.1.3: ties are resolved in score order, not playback order
- Status: found (not re-run on 2.2.0; no 2.2.0 changelog item or tracker issue about it)
- Repro: a tie before `:|` claims the note after the volta, and a tie into ending 2 is
  lost.
- Fix: resolve ties over the unrolled sequence, so a tie only joins the next measure
  that is actually played.
- Upstream: none found. The 2.2.0 and `develop` tie fixes are about drawing ties.
- Workaround: ScoreKit resolves ties over the unrolled order. The web is unaffected only when no tie crosses a repeat or volta.


### OSMD 2.1.3: the metronome beat unit and dots are ignored (questionable, not a clear bug)
- Status: confirmed on latest (re-run on 2.2.0: `metronome-half-note` unchanged, half = 60 plays 60)
- Repro: "half = 60" plays as 60 quarter notes per minute.
- Fix: scale the tempo by the beat unit and its dots. Check upstream's intent first.
- Upstream: 2.2.0 only scales by the ratio of two beat units in a note equation (metric
  modulation, quarter = dotted quarter), a follow-up to
  https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1756. A single
  `<beat-unit>` with `<per-minute>` is still not scaled. Upstream's intent is unknown, so ask first.
- Workaround: ScoreKit uses the raw per-minute value, like the web (parity policy: unit and dots ignored).


### OSMD 2.1.3: `render()` throws "start index of line is greater than the end index" on a trill whose `wavy-line` starts and stops on the same note
- Status: confirmed on latest (2.2.0 throws the same error); probably fixed on `develop`, not run
- Repro: OpenScore Lieder file Grandval, "Les clochettes" (CC0,
  `ScoreKit/Tests/ScoreKitTests/Fixtures/complex/openscore/grandval-les-clochettes.mxl`). The
  voice part has four trills (measures 4, 9, 80, 85) written as a whole note with
  `<trill-mark/>`, `<wavy-line type="start" number="1"/>` and `<wavy-line type="stop" number="1"/>`
  on the same note, followed by trailing grace notes. Minimal MusicXML that fails in both 2.1.3
  and 2.2.0 (one part, one 4/4 measure, `divisions` 8):
  ```xml
  <note><pitch><step>B</step><octave>4</octave></pitch><duration>32</duration><type>whole</type>
    <notations><ornaments><trill-mark/>
      <wavy-line type="start" number="1"/><wavy-line type="stop" number="1"/>
    </ornaments></notations></note>
  ```
  The same note without the two `wavy-line` elements loads fine, and trailing grace notes are not
  needed. Stack: `SkyBottomLineCalculator.updateInRange` <- `calculateWavyLineSkyBottomLine`
  <- `calculateSingleWavyLine` <- `calculateWavyLines`, during `render()`.
- Cause: likely in `VexFlowMusicSheetCalculator.calculateWavyLineSkyBottomLine` (`startX` is moved
  right by the trill mark width, and the stop x of a line over one note ends left of it, so
  `updateInRange` gets end < start and throws). Not stepped through.
- Fix: draw a wavy line over a single note up to the next note, or skip the sky/bottom-line
  update when the range is empty. Add a test sample with start and stop on one note.
- Upstream: no open issue found. Probably fixed on `develop` by
  https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1805 (merged 2026-10-04, after
  2.2.0: "draw one over a single note up to the next note"; says Dolet for Sibelius and MuseScore
  write a trill over one note exactly like this). Not run against `develop`, so unconfirmed. Earlier,
  related, in 2.2.0: https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1733.
- Workaround: none in the web app; the score fails to render. ScoreKit does not use OSMD.

### OSMD 2.1.3: Satie "Je te veux" plays endings 2 and 3 of the first group on the first pass
- Status: found (cause unknown; needs a minimal repro). Same walk in 2.2.0.
- Repro: OpenScore Lieder `ScoreKit/Tests/ScoreKitTests/Fixtures/complex/openscore/satie-je-te-veux.mxl`.
  OSMD walks measures 1-78, 6-35, 38-110. The intended order, worked out from the segno glyphs
  (m6, m78, m110), the verse lyrics in the endings and the "Pour finir" and Fine, is
  1-37, 47-78, 6-35, 38-39, 79-110, 6-35, 40-46 (Fine): refrain with ending 1, verse 1, refrain with
  ending 2, verse 2, refrain with ending 3 up to the Fine. Structure: forward repeat at m6; a first
  group of three endings (ending 1 = m36-37, ending 2 = m38-39, ending 3 = m40 as start +
  discontinue, running on to the Fine at m46); a second group (ending 1 = m47-78 with a backward
  repeat at m78, ending 2 = m79-110 with a backward repeat at m110). OSMD runs 1-78 contiguously, so
  endings 2 and 3 of the first group play on the first pass, and the third pass never happens.
- Cause: unknown. Suspect the handling of a group of three endings followed by a later group with
  a backward repeat, or the `discontinue` ending 3. Part of the intended order needs a heuristic
  (the repeat takes as many passes as the highest ending number in its section, and a one-bar open
  last ending runs on to the Fine), so the file is also under-encoded.
- Fix: reduce first. Try a minimal file: forward repeat, a group of three endings (the third
  start + discontinue), then a later group of two endings with a backward repeat, and compare the
  walk with the endings-by-pass reading.
- Upstream: none found. Not the case fixed by
  https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/1758 (a first ending with
  no second ending).
- Workaround: ScoreKit plays the intended order (known divergence from OSMD). The web plays OSMD's walk.

## VexFlow 5.0.0

Both entries below are open upstream issues from other reporters, read with `gh` on
2026-10-09. We have no fixture of our own for them yet.

### VexFlow 5.0.0: rests collide with notes of other voices
- Status: reported vf#203 (open)
- Repro: none of our own yet; see the example images in the upstream issue.
- Cause: the formatter does not resolve vertical collisions across voices.
- Fix: offset rests against the other voices' notes in the formatter. OSMD works around it
  with its own rest-offset logic.
- Upstream: https://github.com/vexflow/vexflow/issues/203 ("Prevent rests from colliding")
- Workaround: OSMD's own staggering; ScoreKit engraves its own layout.

### VexFlow 5.0.0: the formatter does not avoid vertical collisions
- Status: reported vf#206 (open)
- Repro: none of our own yet; see the image in the upstream issue.
- Cause: collision handling is left to the caller.
- Fix: upstream is undecided; the issue asks whether the formatter or the caller should do it.
- Upstream: https://github.com/vexflow/vexflow/issues/206 ("Formatter vertical collisions")
- Workaround: as above.

## Checked, not bugs

- Stanford "Sou'wester": OSMD walks 1-84, 29-57, 85-141, which is correct. The file exports
  volta 1 as start + discontinue on its first measure (m58) while the backward repeat is at m84.
  ScoreKit used to read the bracket strictly and now extends it to the repeat; OSMD needed no change.
