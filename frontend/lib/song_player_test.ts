import { assertEquals } from "@std/assert";
import { buildScore, practiceSteps, type RawNote } from "./score.ts";
import { accompanyNotes, playPlan } from "./song_player.ts";
import { spell } from "./theory.ts";

let ref = 0;
const note = (midi: number, staff = 0, quarters = 1): RawNote => ({
  midi,
  spelled: spell(midi, "C"),
  staff,
  tie: "none",
  quarters,
  ref: ref++,
});

// 120 BPM: RH quarters C D E F, LH a whole note C3 under them.
const score = buildScore([
  { measure: 1, occurrence: 1, beat: 0, bpm: 120, notes: [note(72), note(48, 1, 4)] },
  { measure: 1, occurrence: 1, beat: 1, bpm: 120, notes: [note(74)] },
  { measure: 1, occurrence: 1, beat: 2, bpm: 120, notes: [note(76)] },
  { measure: 1, occurrence: 1, beat: 3, bpm: 120, notes: [note(77)] },
]);

Deno.test("plan: the right hand practised, the left hand played for you", () => {
  const p = practiceSteps(score, { hands: "rh" });
  const plan = playPlan(score, p, { pct: 100, metronome: true, notes: "other", countIn: true });
  assertEquals(plan.notes, [{ at: 0, midi: 48, dur: 2000 }]);
  assertEquals(plan.clicks, [0, 500, 1000, 1500]);
  assertEquals(plan.countIn, [-2000, -1500, -1000, -500]);
  assertEquals(plan.end, 2000);
});

Deno.test("plan: listen plays everything, slower at a lower tempo %", () => {
  const p = practiceSteps(score, { hands: "both" });
  const plan = playPlan(score, p, { pct: 50, metronome: false, notes: "all", countIn: false });
  assertEquals(plan.notes.map((n) => [n.at, n.midi]), [[0, 72], [0, 48], [1000, 74], [2000, 76], [
    3000,
    77,
  ]]);
  assertEquals(plan.clicks, []);
  assertEquals(plan.countIn, []);
});

// RH plays on beats 0 and 3 only (rests between); LH on every beat, 120 BPM, and
// a LH note before the first RH one.
const gappy = buildScore([
  { measure: 1, occurrence: 1, beat: 0, bpm: 120, notes: [note(48, 1)] },
  { measure: 1, occurrence: 1, beat: 1, bpm: 120, notes: [note(72), note(50, 1)] },
  { measure: 1, occurrence: 1, beat: 2, bpm: 120, notes: [note(52, 1)] },
  { measure: 1, occurrence: 1, beat: 3, bpm: 120, notes: [note(53, 1)] },
  { measure: 1, occurrence: 1, beat: 4, bpm: 120, notes: [note(74), note(55, 1)] },
  { measure: 1, occurrence: 1, beat: 5, bpm: 120, notes: [note(57, 1)] },
]);

Deno.test("accompany: notes between steps and under rests sound, timed from the step", () => {
  const p = practiceSteps(gappy, { hands: "rh" });
  // Step 0 (beat 1): the lead-in note before it (timed from the start), then beats 1..3.
  assertEquals(accompanyNotes(gappy, p, 0).map((n) => [n.midi, n.delay, n.dur]), [
    [48, 0, 500],
    [50, 500, 500],
    [52, 1000, 500],
    [53, 1500, 500],
  ]);
  // Step 1 (beat 4) is the last: everything from there on, to the end of the range.
  assertEquals(accompanyNotes(gappy, p, 1).map((n) => [n.midi, n.delay]), [[55, 0], [57, 500]]);
  // At the player's own, half speed.
  assertEquals(accompanyNotes(gappy, p, 1, 2).map((n) => [n.delay, n.dur]), [[0, 1000], [
    1000,
    1000,
  ]]);
});

Deno.test("accompany: a gap between runs is closed up (a skipped ending)", () => {
  // Measure 1 (beats 0-1), a measure 3 in between (2-3), then measure 2 (4-5).
  // Practising measures 1-2 plays 1 then 2, with the middle taken out.
  const ev = (measure: number, beat: number, notes: RawNote[]) => ({
    measure,
    occurrence: 1,
    beat,
    bpm: 120,
    notes,
  });
  const s = buildScore([
    ev(1, 0, [note(72), note(48, 1)]),
    ev(1, 1, [note(50, 1)]),
    ev(3, 2, [note(76), note(60, 1)]),
    ev(3, 3, [note(61, 1)]),
    ev(2, 4, [note(74), note(52, 1)]),
    ev(2, 5, [note(53, 1)]),
  ]);
  const p = practiceSteps(s, { hands: "rh", from: 1, to: 2 });
  assertEquals(p.steps.length, 2);
  assertEquals(accompanyNotes(s, p, 0).map((n) => [n.midi, n.delay]), [[48, 0], [50, 500]]);
  assertEquals(accompanyNotes(s, p, 1).map((n) => [n.midi, n.delay]), [[52, 0], [53, 500]]);
});
