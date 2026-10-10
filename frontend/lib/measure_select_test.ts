import { assertEquals } from "@std/assert";
import {
  HOLD_SLOP_PX,
  holdElapsed,
  LONG_PRESS_MS,
  measureAt,
  type MeasureBox,
  outsideRange,
  spanBetween,
  stillHolding,
} from "./measure_select.ts";

// Two systems of two measures each.
const boxes: MeasureBox[] = [
  { index: 0, x0: 0, x1: 100, y0: 0, y1: 50 },
  { index: 1, x0: 100, x1: 200, y0: 0, y1: 50 },
  { index: 2, x0: 0, x1: 120, y0: 100, y1: 150 },
  { index: 3, x0: 120, x1: 200, y0: 100, y1: 150 },
];

Deno.test("long press: 500 ms, and only while the pointer stays put", () => {
  assertEquals(LONG_PRESS_MS, 500);
  assertEquals(holdElapsed(499), false);
  assertEquals(holdElapsed(500), true);
  const p = { x: 10, y: 10 };
  assertEquals(stillHolding(p, { x: 10 + HOLD_SLOP_PX, y: 10 }), true);
  assertEquals(stillHolding(p, { x: 10 + HOLD_SLOP_PX + 1, y: 10 }), false);
  assertEquals(stillHolding(p, { x: 15, y: 19 }), false);
});

Deno.test("measureAt: inside a box is that measure", () => {
  assertEquals(measureAt(boxes, 50, 20), 0);
  assertEquals(measureAt(boxes, 150, 20), 1);
  assertEquals(measureAt(boxes, 130, 120), 3);
});

Deno.test("measureAt: outside snaps to the nearest system, then the nearest measure in it", () => {
  assertEquals(measureAt(boxes, 500, 20), 1); // past the right edge
  assertEquals(measureAt(boxes, -30, 130), 2); // left margin
  assertEquals(measureAt(boxes, 150, 70), 1); // gap, nearer the top system
  assertEquals(measureAt(boxes, 150, 90), 3); // gap, nearer the bottom system
  assertEquals(measureAt(boxes, 10, 900), 2); // below everything
});

Deno.test("measureAt: no measures", () => {
  assertEquals(measureAt([], 1, 1), null);
});

Deno.test("spanBetween orders either way", () => {
  assertEquals(spanBetween(2, 5), { from: 2, to: 5 });
  assertEquals(spanBetween(5, 2), { from: 2, to: 5 });
  assertEquals(spanBetween(3, 3), { from: 3, to: 3 });
});

Deno.test("outsideRange: everything but the range; nothing for the whole piece", () => {
  assertEquals(outsideRange(6, 3, 4), [0, 1, 4, 5]);
  assertEquals(outsideRange(6, 1, 2), [2, 3, 4, 5]);
  assertEquals(outsideRange(6, 5, 6), [0, 1, 2, 3]);
  assertEquals(outsideRange(6, 1, 6), []);
  assertEquals(outsideRange(1, 1, 1), []);
});
