import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { NotesEngine, TempoEngine } from "./engine.ts";
import { playPlan } from "./song_player.ts";
import {
  bpmAt,
  buildScore,
  chooseParts,
  heatLevel,
  measureLabel,
  measureStarts,
  measureStats,
  msAt,
  nearestStep,
  practiceSteps,
  type RawEntry,
  type RawNote,
  runMs,
  sliceFrom,
  stepCandidates,
  stepFromMeasure,
  stepOffsets,
  stepOfRef,
  weakestRange,
} from "./score.ts";
import { type Letter, spell } from "./theory.ts";

let ref = 0;
const LETTER: Record<number, Letter> = { 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" };
function n(midi: number, staff = 0, extra: Partial<RawNote> = {}): RawNote {
  return {
    midi,
    spelled: spell(midi, LETTER[midi % 12] ?? "C"),
    staff,
    tie: "none",
    quarters: 1,
    ref: ref++,
    ...extra,
  };
}
// Occurrence defaults to one per written measure (no repeats).
const at = (
  measure: number,
  beat: number,
  notes: RawNote[],
  bpm = 120,
  occurrence = measure,
): RawEntry => ({
  measure,
  occurrence,
  beat,
  bpm,
  notes,
});

// Two measures of 4/4 at 120: RH melody C D E F | G (half) G (half);
// LH whole-note C3 then G2. A rest-only position is included.
function twoHandPiece(): RawEntry[] {
  return [
    at(1, 0, [n(72), n(48, 1, { quarters: 4 })]),
    at(1, 1, [n(74)]),
    at(1, 2, [n(76)]),
    at(1, 3, [n(77)]),
    at(2, 4, [n(79, 0, { quarters: 2 }), n(43, 1, { quarters: 4 })]),
    at(2, 6, [n(79, 0, { quarters: 2 })]),
    at(2, 7, []),
  ];
}

Deno.test("build: events in time order, hands from staves, rests dropped", () => {
  const s = buildScore(twoHandPiece());
  assertEquals(s.events.length, 6);
  assertEquals(s.events.map((e) => e.beat), [0, 1, 2, 3, 4, 6]);
  assertEquals(s.events[0].notes.map((x) => x.hand), ["rh", "lh"]);
  assertEquals(s.measures, [1, 2]);
  assertEquals(s.measureCount, 2);
  assert(s.twoHands);
});

Deno.test("build: voices reported apart at one moment merge into one event", () => {
  const s = buildScore([at(1, 0, [n(60)]), at(1, 0, [n(64)]), at(1, 1, [n(62)])]);
  assertEquals(s.events.length, 2);
  assertEquals(s.events[0].notes.map((x) => x.midi), [60, 64]);
});

Deno.test("tempo map: milliseconds follow tempo changes and the tempo %", () => {
  // 120 BPM for 4 beats, then 60 BPM.
  const s = buildScore([at(1, 0, [n(60)], 120), at(2, 4, [n(62)], 60), at(2, 5, [n(64)], 60)]);
  assertEquals(s.tempo, [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
  assertEquals(msAt(s.tempo, 4), 2000);
  assertEquals(msAt(s.tempo, 5), 3000);
  assertEquals(msAt(s.tempo, 5, 50), 6000); // half speed
  assertEquals(bpmAt(s.tempo, 4.5), 60);
});

Deno.test("tempo map: a file without a tempo plays at 100 BPM", () => {
  const s = buildScore([at(1, 0, [n(60)], 0), at(1, 1, [n(62)], 0)]);
  assertEquals(s.tempo, [{ beat: 0, bpm: 100 }]);
  assertEquals(msAt(s.tempo, 1), 600);
});

Deno.test('tempo map: a zero tempo (OSMD 2.2.0 for tempo="0") keeps the tempo in force', () => {
  const s = buildScore([at(1, 0, [n(60)], 92), at(2, 4, [n(62)], 0), at(2, 5, [n(64)], 0)]);
  assertEquals(s.tempo, [{ beat: 0, bpm: 92 }]);
});

Deno.test("selection: both hands grade chords; one hand leaves the other as accompaniment", () => {
  const s = buildScore(twoHandPiece());
  const both = practiceSteps(s, { hands: "both" });
  assertEquals(both.steps.length, 6);
  assertEquals(both.steps[0].notes.map((x) => [x.midi, x.hand]), [[72, "rh"], [48, "lh"]]);
  assertEquals(both.accompaniment, []);

  const lh = practiceSteps(s, { hands: "lh" });
  assertEquals(lh.steps.map((x) => x.notes.map((y) => y.midi)), [[48], [43]]);
  assertEquals(lh.beats, [0, 4]);
  assertEquals(lh.accompaniment.map((a) => a.midi), [72, 74, 76, 77, 79, 79]);
  assertEquals(lh.steps.map((x) => x.index), [0, 1]);
});

Deno.test("selection: a measure range, timed from its own start", () => {
  const s = buildScore(twoHandPiece());
  const p = practiceSteps(s, { hands: "rh", from: 2, to: 2 });
  assertEquals(p.beats, [4, 6]);
  assertEquals(p.startBeat, 4);
  assertEquals(stepOffsets(s, p), [0, 1000]);
  assertEquals(stepOffsets(s, p, 50), [0, 2000]);
});

Deno.test("selection: tied continuations sound but are not played again", () => {
  // A half note C tied over the bar into a quarter, then D.
  const s = buildScore([
    at(1, 2, [n(60, 0, { tie: "start", quarters: 3 })]),
    at(2, 4, [n(60, 0, { tie: "continue", quarters: 1 })]),
    at(2, 5, [n(62)]),
  ]);
  const p = practiceSteps(s, { hands: "both" });
  assertEquals(p.steps.map((x) => x.notes.map((y) => y.midi)), [[60], [62]]);
  assertEquals(p.all.map((a) => [a.midi, a.quarters]), [[60, 3], [62, 1]]);
});

Deno.test("selection: a pitch in both hands is graded once, so the step can finish", () => {
  const s = buildScore([at(1, 0, [n(60), n(60, 1)])]);
  const p = practiceSteps(s, { hands: "both" });
  assertEquals(p.steps[0].notes.length, 1);
  const e = new NotesEngine(p.steps);
  e.input({ type: "on", midi: 60, velocity: 80, t: 0 });
  assert(e.done);
});

Deno.test("selection: repeats play measures twice, in order", () => {
  // |: m1 :| m2, played out: m1 m1 m2.
  const s = buildScore([
    at(1, 0, [n(60)], 120, 1),
    at(1, 4, [n(60)], 120, 2),
    at(2, 8, [n(62)], 120, 3),
  ]);
  assertEquals(s.measures, [1, 1, 2]);
  // A range plays each measure once; the whole piece keeps both passes.
  assertEquals(practiceSteps(s, { hands: "both", from: 1, to: 1 }).steps.length, 1);
  assertEquals(practiceSteps(s, { hands: "both", from: 1, to: 2 }).steps.length, 3);
});

Deno.test("the engines grade a song selection end to end", () => {
  const s = buildScore(twoHandPiece());
  const p = practiceSteps(s, { hands: "rh" });
  const offsets = stepOffsets(s, p);
  assertEquals(offsets, [0, 500, 1000, 1500, 2000, 3000]);
  const e = new TempoEngine(p.steps, { bpm: 120, notesPerBeat: 1, startTime: 0, offsets });
  // Play everything on time except the last G, which is missed.
  p.steps.slice(0, 5).forEach((st, i) =>
    e.input({ type: "on", midi: st.notes[0].midi, velocity: 80, t: offsets[i] + 5 })
  );
  e.tick(10000);
  const stats = measureStats(p, e.results);
  assertEquals(stats.map((m) => [m.measure, m.steps, m.clean, m.missed]), [[1, 4, 4, 0], [
    2,
    2,
    1,
    1,
  ]]);
  assertEquals(weakestRange(stats, 1), { from: 2, to: 2 });
  assertAlmostEquals(e.summary().accuracy, 5 / 6, 1e-9);
});

Deno.test("weakest range: none when everything was clean", () => {
  assertEquals(
    weakestRange([{ measure: 1, steps: 2, clean: 2, wrong: 0, missed: 0, early: 0, late: 0 }]),
    null,
  );
});

Deno.test("parts: a piano on two staves, wherever it is", () => {
  assertEquals(chooseParts([{ name: "Piano", staves: 2 }]), [{ part: 0, staffOffset: 0 }]);
  assertEquals(
    chooseParts([{ name: "Voice", staves: 1 }, { name: "Pianoforte", staves: 2 }]),
    [{ part: 1, staffOffset: 0 }],
  );
});

Deno.test("parts: a piano written as two parts plays as two hands", () => {
  assertEquals(
    chooseParts([{ name: "Piano (right)", staves: 1 }, { name: "Piano (left)", staves: 1 }]),
    [{ part: 0, staffOffset: 0 }, { part: 1, staffOffset: 1 }],
  );
  assertEquals(
    chooseParts([{ name: "Flute", staves: 1 }, { name: "RH", staves: 1 }, {
      name: "LH",
      staves: 1,
    }]),
    [{ part: 1, staffOffset: 0 }, { part: 2, staffOffset: 1 }],
  );
});

Deno.test("parts: otherwise the first part", () => {
  assertEquals(
    chooseParts([{ name: "Violin I", staves: 1 }, { name: "Violin II", staves: 1 }]),
    [{ part: 0, staffOffset: 0 }],
  );
  assertEquals(chooseParts([]), []);
});

Deno.test("navigation: measure starts, back and forward, repeats counted twice", () => {
  // |: m1 (two notes) :| m2 (two notes), played out: m1 m1 m2.
  const s = buildScore([
    at(1, 0, [n(60)], 120, 1),
    at(1, 2, [n(62)], 120, 1),
    at(1, 4, [n(60)], 120, 2),
    at(1, 6, [n(62)], 120, 2),
    at(2, 8, [n(64)], 120, 3),
    at(2, 10, [n(65)], 120, 3),
  ]);
  const p = practiceSteps(s, { hands: "both" });
  assertEquals(measureStarts(p), [0, 2, 4]);
  assertEquals(stepFromMeasure(p, 0, 1), 2); // into the repeat
  assertEquals(stepFromMeasure(p, 4, 1), 4); // last measure: stays
  assertEquals(stepFromMeasure(p, 3, -1), 2); // mid-measure: to its start
  assertEquals(stepFromMeasure(p, 2, -1), 0); // at a start: the measure before
  assertEquals(stepFromMeasure(p, 0, -1), 0);
});

Deno.test("seeking: a clicked note maps to its step, slices time from there", () => {
  const s = buildScore(twoHandPiece());
  const p = practiceSteps(s, { hands: "rh" });
  const lhRef = s.events[4].notes.find((x) => x.hand === "lh")!.ref; // under the G at beat 4
  assertEquals(stepOfRef(s, p, p.events[2].notes[0].ref), 2);
  assertEquals(stepOfRef(s, p, lhRef), 4); // not graded for RH: the step at its beat
  const tail = sliceFrom(p, 4);
  assertEquals(tail.steps.map((x) => x.index), [0, 1]);
  assertEquals(tail.startBeat, 4);
  assertEquals(stepOffsets(s, tail), [0, 1000]);
  assertEquals(tail.accompaniment.map((a) => a.midi), [43]);
});

// |: m1 m2 :| m3 | m4, played out: m1 m2 m1 m2 m3 m4. One note a measure, 4 quarters
// long, at 120 BPM (2 s a measure); beats 0 4 8 12 16 20. Refs are shared by
// the passes, as ScoreView.walk gives them.
function repeated() {
  const r = [0, 1, 2, 3].map(() => n(60));
  const e = (m: number, beat: number, occ: number, k: number) =>
    at(m, beat, [{ ...r[k], midi: 60 + k, quarters: 4, ref: 100 + k }], 120, occ);
  return buildScore([
    e(1, 0, 1, 0),
    e(2, 4, 2, 1),
    e(1, 8, 3, 0),
    e(2, 12, 4, 1),
    e(3, 16, 5, 2),
    e(4, 20, 6, 3),
  ]);
}

Deno.test("range: a measure inside a repeat plays its first pass only, with no dead time", () => {
  const s = repeated();
  const p = practiceSteps(s, { hands: "both", from: 2, to: 2 });
  assertEquals(p.beats, [4]);
  assertEquals(p.spans, []);
  const q = practiceSteps(s, { hands: "both", from: 1, to: 2 });
  assertEquals(q.beats, [0, 4]); // not 0 4 8 12
  assertEquals(stepOffsets(s, q), [0, 2000]);
  const plan = playPlan(s, q, { pct: 100, metronome: true, notes: "all", countIn: false });
  assertEquals(plan.clicks.length, 8); // a click on each of 8 beats
  assertEquals(plan.end, 4000);
});

Deno.test("range: the whole piece keeps its repeats; stats still key on the written measure", () => {
  const s = repeated();
  const all = practiceSteps(s, { hands: "both" });
  assertEquals(all.events.map((e) => e.measure), [1, 2, 1, 2, 3, 4]);
  const full = practiceSteps(s, { hands: "both", from: 1, to: 4 });
  assertEquals(full.beats, all.beats);
  const res = all.steps.map(() => ({ status: "ok", clean: true, wrong: [], grade: null }));
  assertEquals(measureStats(all, res).map((m) => [m.measure, m.steps]), [[1, 2], [2, 2], [3, 1], [
    4,
    1,
  ]]);
});

Deno.test("range: measures that are not adjacent in play close up the gap between them", () => {
  // m2 (first pass, beat 4) and m3 (beat 16) with the second pass of m1 m2 between: two runs.
  const s = repeated();
  const p = practiceSteps(s, { hands: "both", from: 2, to: 3 });
  assertEquals(p.beats, [4, 16]);
  assertEquals(p.spans, [{ from: 4, to: 8 }, { from: 16, to: Infinity }]);
  assertEquals(stepOffsets(s, p), [0, 2000]); // m3 follows m2 at once
  assertEquals(runMs(s.tempo, p, 10), 2000); // a beat in the gap is the end of the run before
  const plan = playPlan(s, p, { pct: 100, metronome: true, notes: "all", countIn: true });
  assertEquals(plan.clicks.length, 8); // four beats in each run, none in the gap
  assertEquals(plan.clicks[4], 2000);
  assertEquals(plan.end, 4000);
  assertEquals(plan.countIn, [-2000, -1500, -1000, -500]);
  // Slicing from the second run keeps one run.
  const tail = sliceFrom(p, 1);
  assertEquals(tail.spans, []);
  assertEquals(stepOffsets(s, tail), [0]);
});

Deno.test("seek: a tap in a repeated measure picks the pass nearest the current step", () => {
  const s = repeated();
  const p = practiceSteps(s, { hands: "both" }); // steps: m1 m2 m1 m2 m3 m4
  assertEquals(stepCandidates(s, p, 100), [0, 2]);
  assertEquals(stepOfRef(s, p, 100, 0), 0);
  assertEquals(stepOfRef(s, p, 100, 3), 2); // second pass: stay in it
  assertEquals(stepOfRef(s, p, 101, 3), 3);
  assertEquals(stepOfRef(s, p, 101, 1), 1);
  assertEquals(stepOfRef(s, p, 100, 1), 2); // equidistant: the later one
  assertEquals(stepOfRef(s, p, 999, 3), 0); // unknown ref
  assertEquals(nearestStep([], 5), 0);
});

Deno.test("seek: a range of one pass has one candidate; a note out of range goes to the next step", () => {
  const s = repeated();
  const p = practiceSteps(s, { hands: "both", from: 2, to: 3 }); // steps: m2 (4), m3 (16)
  assertEquals(stepCandidates(s, p, 101), [0]); // m2 is in the range on its first pass only
  assertEquals(stepCandidates(s, p, 100), [0, 1]); // m1 is out of range: the step at or after each pass
  assertEquals(stepCandidates(s, p, 103), [1]); // m4 is past the end: the last step
});

Deno.test("seek: the other hand's note, a tie-only position and a rest go to the step at their beat", () => {
  // RH only. Beat 0: RH 60 + LH 48. Beat 1: only a tied continuation (LH). Beat 2: RH 62.
  const s = buildScore([
    at(1, 0, [n(60), n(48, 1, { tie: "start", quarters: 2 })]),
    at(1, 1, [n(48, 1, { tie: "continue" })]),
    at(1, 2, [n(62)]),
  ]);
  const p = practiceSteps(s, { hands: "rh" });
  assertEquals(p.beats, [0, 2]);
  const tie = s.events[1].notes[0].ref;
  const lh = s.events[0].notes[1].ref;
  assertEquals(stepOfRef(s, p, tie), 1); // no step of its own: the next one
  assertEquals(stepOfRef(s, p, lh), 0);
});

Deno.test("printed numbers: labels follow <measure number>, a pickup is 0", () => {
  const s = buildScore([
    { ...at(1, 0, [n(60)]), printed: 0 },
    { ...at(2, 1, [n(62)]), printed: 1 },
    { ...at(3, 5, [n(64)]), printed: 2 },
  ]);
  assertEquals(s.printed, [0, 1, 2]);
  assertEquals(measureLabel(s, 1), 0);
  assertEquals(measureLabel(s, 3), 2);
  assertEquals(measureLabel(s, 9), 9); // unknown: as written
  // Without a printed number the label is the written one.
  assertEquals(buildScore(twoHandPiece()).printed, [1, 2]);
  // A repeat keeps the first pass's label.
  assertEquals(repeated().printed, [1, 2, 3, 4]);
});

Deno.test("heat level: clean is 4, then down to 0", () => {
  assertEquals(heatLevel({ steps: 4, clean: 4 }), 4);
  assertEquals(heatLevel({ steps: 4, clean: 3 }), 3);
  assertEquals(heatLevel({ steps: 4, clean: 2 }), 2);
  assertEquals(heatLevel({ steps: 4, clean: 1 }), 1);
  assertEquals(heatLevel({ steps: 4, clean: 0 }), 0);
  assertEquals(heatLevel({ steps: 0, clean: 0 }), 4);
});
