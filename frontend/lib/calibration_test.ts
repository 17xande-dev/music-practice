import { assert, assertEquals } from "@std/assert";
import { describeLatency, estimateLatency } from "./calibration.ts";

const clicks = Array.from({ length: 12 }, (_, k) => 1000 + k * 667);

Deno.test("steady taps 40 ms late measure 40 ms", () => {
  const taps = clicks.map((c, k) => c + 40 + (k % 3) - 1); // 39–41 ms
  const r = estimateLatency(clicks, taps);
  assert(r.ok);
  assertEquals(r.setting, 40);
  assertEquals(r.taps, 12);
  assert(describeLatency(r).includes("40 ms after"));
});

Deno.test("stray taps and a missed click don't skew the result", () => {
  const taps = [500, ...clicks.slice(0, 6).map((c) => c + 62), clicks[7] + 58, 99999];
  const r = estimateLatency(clicks, taps);
  assert(r.ok);
  assertEquals(r.taps, 7);
  assertEquals(r.setting, 60);
});

Deno.test("two taps on one click count once", () => {
  const taps = clicks.flatMap((c) => [c + 30, c + 35]);
  const r = estimateLatency(clicks, taps);
  assert(r.ok);
  assertEquals(r.taps, 12);
  assertEquals(r.setting, 30);
});

Deno.test("early taps mean no offset; the field stays within 0–300 ms", () => {
  const early = estimateLatency(clicks, clicks.map((c) => c - 20));
  assert(early.ok);
  assertEquals(early.setting, 0);
  assert(describeLatency(early).includes("ahead"));
  const huge = estimateLatency(clicks, clicks.map((c) => c + 245));
  assert(huge.ok);
  assertEquals(huge.setting, 245);
});

Deno.test("too few or uneven taps ask for another try", () => {
  const few = estimateLatency(clicks, clicks.slice(0, 3).map((c) => c + 30));
  assertEquals(few.ok, false);
  assert(describeLatency(few).includes("Only 3 taps"));
  const uneven = estimateLatency(clicks, clicks.map((c, k) => c + (k % 2 ? 150 : -100)));
  assertEquals(!uneven.ok && uneven.reason, "uneven");
});
