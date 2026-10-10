# Fixes to bring over from the iPad app

The iPad app (music-practice-app, with its ScoreKit library) was ported from this web app. In a few
places it deliberately behaves differently, because the web behaviour here is a bug or a poor
experience. Each item below is a fix the web app should adopt so the two match again. When one is
done, also update the parity fixtures (`deno task score-fixtures`) and remove the matching "known
divergence" from ScoreKit's `TimelineParityTests` / MusicCore's `SongParityTests`.

## Playback order and tempo (OSMD bugs; the web is on 2.2.0)

The web gets these from OSMD's cursor walk (`frontend/lib/score_walk.ts`). Fixing them means
post-processing the walk, or building the timeline ourselves, rather than trusting
`cursor.iterator`. Evidence for each is in `frontend/lib/testdata/fixtures/README.md` ("OSMD
probes"). ScoreKit's behaviour is in `ScoreKit/Sources/ScoreKit/Timeline/`.

- [ ] **`<repeat times="N">` is ignored.** OSMD always plays a repeat twice
      (`RepetitionInstruction.Times` is never read). Fix: honour `times`. ScoreKit caps it at 16.
      Fixture: `repeat-times-3`.
- [ ] **Ending numbers keep only the first digit.** `number="1, 2"` becomes `[1]`. Fix: parse comma
      lists and ranges, so a repeat with endings "1, 2" then "3" plays 1 2 1 2 1 3 4. Fixture:
      `ending-multi-number`.
- [ ] **Ending text overrides the `number` attribute.** "First time"/"Second time" with no digits
      stops measures from playing, and swapped digits play the piece twice. Fix: `number` governs;
      text is only the label. Fixtures: `ending-text-differs`, `ending-text-digits-swapped`.
- [ ] **A hidden ending (`print-object="no"`) is skipped entirely.** Fix: it still plays; only the
      bracket is hidden. Fixture: `ending-print-object-no`.
- [x] **Tempo `<offset>`.** Fixed by OSMD 2.2.0, which now matches ScoreKit (offset ignored without
      `sound="yes"`, tempo at the direction's own position): remove the divergence on the Swift
      side. (Original problem: A direction's offset applies only at a measure start, and a
      mid-measure tempo with an offset never takes effect. Fix: follow the MusicXML spec. A
      direction's `<offset>` affects playback only with `sound="yes"`; `<sound><offset>` always
      does.) Fixtures: `tempo-offset`, `tempo-offset-mid-measure`.
- [x] **`tempo="0"`** (OSMD 2.2.0 gives 0, 2.1.3 gave 60): done for zero. `buildScore` ignores a
      zero BPM and keeps the current tempo, like ScoreKit. **An invalid `tempo="fast"` still resets
      to 100** in the walk and cannot be told from a real 100 (open). Fixture:
      `sound-decimal-tempo`.
- [x] **A `<metronome>` and a `<sound tempo>` in one direction**: OSMD 2.2.0 takes the `<sound>`
      value (120), as the MusicXML spec says. Decided 2026-10-09: ScoreKit (`TempoMap`) does the
      same, so the web and the iPad agree; no divergence left. Fixture:
      `sound-and-metronome-differ`. (`Metronome.quarterBPM` stays for display.)
- [ ] **Tempo words (`Largo`, `Allegro`, ...) set a tempo in OSMD** (Largo 52, Allegro 130) when
      there is no metronome mark or `<sound tempo>`. ScoreKit treats them as display only (default
      100). Decide whether the iPad should port OSMD's table. Fixture:
      `lilypond-21d-Chords-SchubertStabatMater`.
- [ ] **Ties are paired across measures when the start is written after the stop in the file**
      (Stanford "Sou'wester"): OSMD joins the start in bar 1 to the stop in bar 3. Fix: pair in time
      order within the measure. Fixture: `openscore-stanford-sou-wester`. Also see
      `upstream-bugs.md` (Boulanger bar 11 beat drift).
- [ ] **Ties are resolved in score order, not playback order.** A tie before `:|` claims the note
      after the volta, and a tie into ending 2 is lost. Fix: resolve ties over the unrolled sequence
      (a tie only joins the next played measure).
- [ ] **Under-encoded endings play in the wrong order.** In Satie's "Je te veux" (OpenScore), OSMD
      walks 1-78, 6-35, 38-110. The intended order, from the segno signs and the lyrics, is 1-37,
      47-78, 6-35, 38-39, 79-110, 6-35, 40-46 (Fine). ScoreKit counts a repeat's passes from the
      highest ending in its section, and extends an open one-bar final ending to Fine. Fixture:
      ScoreKit `complex/openscore/satie-je-te-veux.mxl`. See `upstream-bugs.md`.
- [ ] _(Optional, musical)_ **Metronome beat unit and dots are ignored.** "half = 60" plays as 60
      quarters per minute. ScoreKit currently matches OSMD here (`Metronome.quarterBPM` holds the
      correct value). Decide whether both should switch.

## Songs page behaviour (`frontend/songs.ts`, `frontend/lib/score.ts`)

Done 2026-10-09 (this section's items were fixed on the web and are removed): a measure range plays
one pass continuously (`practiceSteps` first pass + `spans`); Listen follows the metronome option;
tap to seek picks the pass nearest the current step and maps other-hand, tie-only and out-of-range
notes to the step at their beat (`stepOfRef`; repeat passes share one `ref` in `ScoreView.walk`); a
tempo change continues Listen and restarts Tempo/Rubato from the current step (`tempoChange`); a
seek after a finished run starts fresh; a Tempo run ends once the audio has played out
(`tempoRunOver`); the range is remembered per song (`Settings.songRanges`, not exported, dropped
with the song); the results heat map also tints the score (`ScoreView.setHeat`). Parity fixtures
regenerated: `m2-3` now plays one pass, with `spans` (see the fixtures README), so the iPad's "known
divergence" for ranges in `SongParityTests` / `TimelineParityTests` can go.

Left, not needed on the web: tap-to-seek on a _rest_ (the web's tap picks the nearest note, so a
rest is never the target; `stepOfPosition` has no use here). The Tempo-mode toggle item is listed
below.

## Small open web item

- [ ] **Tempo mode: toggling the metronome or the other hand mid-run replays from the current
      step.** The iPad does this (with a count-in); the web applies the change at the next Play.
      Deliberately left iPad-only for now; the web should adopt it.

## Shared quirks to fix in both apps

- [x] **Accompaniment in wait modes only sounded other-hand notes that coincide with a practised
      step.** Fixed on the web: `accompanyNotes` (`frontend/lib/song_player.ts`) returns every
      other-hand note in [beat(k), beat(k+1)) with a `delay`, scaled to the run tempo (gaps between
      spans closed up via `runMs`; step 0 also takes the lead-in from `startBeat`; the last step
      runs to the end); `SongPlayer.playNow` schedules by `delay`. Done on the iPad (MusicCore
      `accompanyNotes`, per-note delays in `playNow`).
- [x] **A note followed by an immediate reset logged a 0 ms Learn entry.** Fixed on the web:
      `LearnClock.worthLogging` (`frontend/lib/learn_log.ts`, `ms > 0`) guards `logLearn` in
      `practice.ts` and `songs.ts`. Done on the iPad (`LearnClock.worthLogging`).

## Library limitations (OSMD / VexFlow), to fix in both apps

- [x] **Measure numbers** are labelled with the printed `<measure number>` (pickup = 0) in the heat
      cells, "Practise measure N", the range pickers (now selects) and the status line;
      `RawEntry.printed` from OSMD's `getPrintedMeasureNumber()`, `Score.printed`, `measureLabel`.
      The stored measure stays the written index (sessions, export).

## Not divergences, but worth knowing

- The cursor band is centred on the notehead on iPad. The web's band starts 1.5 units left of the
  staff entry, as OSMD places it.
- ScoreKit draws the line view without a sticky clef or key signature, as the web does. It's on the
  iPad polish backlog.
- The iPad reopens on the last page and song (UserDefaults); the web uses its URL.
- **History sync is web-only for now.** The server and the web client sync practice runs through an
  account; the iPad app doesn't yet. [`ipad-sync-handoff.md`](ipad-sync-handoff.md) is the brief for
  adding it, against the contract in [`sync-api.md`](sync-api.md).
