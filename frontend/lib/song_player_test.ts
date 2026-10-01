import { assertEquals } from "@std/assert";
import { buildScore, practiceSteps, type RawNote } from "./score.ts";
import { playPlan } from "./song_player.ts";
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
