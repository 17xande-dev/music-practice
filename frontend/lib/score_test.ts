import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { NotesEngine, TempoEngine } from "./engine.ts";
import {
  bpmAt,
  buildScore,
  chooseParts,
  measureStats,
  msAt,
  practiceSteps,
  type RawEntry,
  type RawNote,
  stepOffsets,
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
  assertEquals(practiceSteps(s, { hands: "both", from: 1, to: 1 }).steps.length, 2);
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
