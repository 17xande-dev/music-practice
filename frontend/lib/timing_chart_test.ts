import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { TimingSummary } from "./engine.ts";
import { chartRange } from "./timing_chart.ts";

const summary = (deviations: (number | null)[], toleranceMs = 60): TimingSummary => ({
  onTime: 0,
  early: 0,
  late: 0,
  missed: 0,
  meanAbsMs: null,
  meanSignedMs: null,
  toleranceMs,
  deviations,
});

Deno.test("chart range: three tolerances, or wider for an outlier, capped at half the gap", () => {
  assertEquals(chartRange(summary([0, 10, -20]), 500), 180); // 3 × tolerance
  assertAlmostEquals(chartRange(summary([0, 200, null]), 500), 220); // worst × 1.1
  assertEquals(chartRange(summary([0, 240]), 250), 125); // never past half the interval
});
