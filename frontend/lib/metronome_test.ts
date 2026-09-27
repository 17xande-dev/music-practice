import { assertAlmostEquals, assertEquals } from "@std/assert";
import { clickTimes } from "./metronome.ts";

Deno.test("one bar of count-in, then a click per beat of the exercise", () => {
  const c = clickTimes(10, 120, 1, 15);
  assertEquals(c.countIn, [10, 10.5, 11, 11.5]);
  assertEquals(c.stepZero, 12);
  assertEquals(c.beats.length, 15);
  assertEquals(c.beats[14], 12 + 14 * 0.5);
});

Deno.test("subdivided steps share beats; a partial last beat still clicks", () => {
  const c = clickTimes(0, 60, 2, 15); // 15 eighth notes = 7.5 beats
  assertEquals(c.beats.length, 8);
  assertAlmostEquals(c.stepZero, 4);
});
