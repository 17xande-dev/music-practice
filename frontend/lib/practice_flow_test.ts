import { assertEquals } from "@std/assert";
import { nextKeys, restartsOnNote } from "./practice_flow.ts";
import { buildScore, practiceSteps } from "./score.ts";
import { spell } from "./theory.ts";

const step = (...midis: number[]) => ({ notes: midis.map((midi) => ({ midi })) });

Deno.test("restart: only a note-on, on a finished run, in a restartable mode", () => {
  assertEquals(restartsOnNote("on", true, true), true);
  assertEquals(restartsOnNote("off", true, true), false);
  assertEquals(restartsOnNote("on", false, true), false);
  assertEquals(restartsOnNote("on", true, false), false);
});

Deno.test("next keys: the following step, whole chord", () => {
  const steps = [step(60), step(62, 65, 69), step(64)];
  assertEquals(nextKeys(steps, 0), [62, 65, 69]);
  assertEquals(nextKeys(steps, 1), [64]);
});

Deno.test("next keys: none at the end, or when nothing is current", () => {
  const steps = [step(60), step(62)];
  assertEquals(nextKeys(steps, 1), []);
  assertEquals(nextKeys(steps, -1), []);
  assertEquals(nextKeys([], 0), []);
});

Deno.test("next keys: a key that is also a current target is left to the current highlight", () => {
  assertEquals(nextKeys([step(60, 64), step(60, 67)], 0), [67]);
  assertEquals(nextKeys([step(60), step(60)], 0), []);
});

let ref = 0;
const note = (midi: number, staff = 0) => ({
  midi,
  spelled: spell(midi, "C"),
  staff,
  tie: "none" as const,
  quarters: 1,
  ref: ref++,
});
const at = (
  measure: number,
  occurrence: number,
  beat: number,
  notes: ReturnType<typeof note>[],
) => ({
  measure,
  occurrence,
  beat,
  bpm: 120,
  notes,
});
// Measures 1 and 2, played twice (a repeat), both hands; the left hand sits out beat 1.
const piece = () =>
  buildScore([
    at(1, 1, 0, [note(60), note(48, 1)]),
    at(1, 1, 1, [note(50, 1)]),
    at(2, 2, 2, [note(62)]),
    at(1, 3, 3, [note(60), note(48, 1)]),
    at(1, 3, 4, [note(50, 1)]),
    at(2, 4, 5, [note(62)]),
  ]);

Deno.test("next keys: practised hands only, whole chord when both", () => {
  const s = piece();
  const rh = practiceSteps(s, { hands: "rh" });
  assertEquals(nextKeys(rh.steps, 0), [62]); // the left hand's lone note is accompaniment
  const both = practiceSteps(s, { hands: "both" });
  assertEquals(nextKeys(both.steps, 0), [50]);
  assertEquals(nextKeys(both.steps, 1), [62]);
});

Deno.test("next keys: a repeat's second pass follows the first, and the end has none", () => {
  const rh = practiceSteps(piece(), { hands: "rh" });
  assertEquals(rh.steps.map((x) => x.notes[0].midi), [60, 62, 60, 62]);
  assertEquals(nextKeys(rh.steps, 1), [60]);
  assertEquals(nextKeys(rh.steps, 3), []);
});

Deno.test("next keys: a one-pass range ends at its last measure", () => {
  const r = practiceSteps(piece(), { hands: "both", from: 1, to: 1 });
  assertEquals(r.steps.length, 2);
  assertEquals(nextKeys(r.steps, 0), [50]);
  assertEquals(nextKeys(r.steps, 1), []);
});
