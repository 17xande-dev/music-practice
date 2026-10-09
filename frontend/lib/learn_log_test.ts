import { assertEquals } from "@std/assert";
import {
  formatDuration,
  IDLE_CAP_MS,
  LearnClock,
  type LearnSession,
  measureList,
  stumbleMeasures,
  summarizeLearning,
} from "./learn_log.ts";

function learn(over: Partial<LearnSession> = {}): LearnSession {
  return {
    id: crypto.randomUUID(),
    ts: 1000,
    kind: "song",
    subject: "song-1",
    title: "Minuet",
    hands: "both",
    durationMs: 60_000,
    steps: 10,
    total: 10,
    wrongNotes: 2,
    complete: true,
    ...over,
  };
}

Deno.test("the clock counts gaps between notes, capping long pauses", () => {
  const c = new LearnClock();
  assertEquals(c.started, false);
  c.note(1000);
  c.note(3000);
  c.note(3000 + 5 * 60_000); // walked away
  c.note(3000 + 5 * 60_000 + 500);
  assertEquals(c.started, true);
  assertEquals(c.ms, 2000 + IDLE_CAP_MS + 500);
});

Deno.test("a single note, or notes at one instant, is not worth logging", () => {
  const c = new LearnClock();
  assertEquals(c.worthLogging, false);
  c.note(1000);
  assertEquals(c.started, true);
  assertEquals(c.worthLogging, false);
  c.note(1000);
  assertEquals(c.worthLogging, false);
  c.note(1400);
  assertEquals(c.worthLogging, true);
});

Deno.test("stumbles: measures with the most unclean steps, in measure order", () => {
  const ms = stumbleMeasures([
    learn({ measures: [{ measure: 1, steps: 4, clean: 4 }, { measure: 2, steps: 4, clean: 1 }] }),
    learn({ measures: [{ measure: 5, steps: 4, clean: 2 }, { measure: 2, steps: 4, clean: 3 }] }),
    learn({ measures: [{ measure: 7, steps: 4, clean: 3 }, { measure: 9, steps: 4, clean: 3 }] }),
  ], 3);
  assertEquals(ms, [2, 5, 7]);
  assertEquals(stumbleMeasures([learn()]), []);
});

Deno.test("summary: one row per subject, newest first, passes counted when complete", () => {
  const rows = summarizeLearning([
    learn({ ts: 1, complete: false }),
    learn({ ts: 2 }),
    learn({ ts: 3, kind: "scale", subject: "C0|major", title: "C major" }),
    learn({ ts: 4, kind: "scale", subject: "C0|major", title: "C major", instrument: "guitar" }),
  ]);
  assertEquals(rows.map((r) => [r.title, r.instrument, r.passes, r.sessions, r.totalMs]), [
    ["C major", "guitar", 1, 1, 60_000],
    ["C major", undefined, 1, 1, 60_000],
    ["Minuet", undefined, 1, 2, 120_000],
  ]);
});

Deno.test("durations and measure lists read naturally", () => {
  assertEquals(formatDuration(40_000), "40 s");
  assertEquals(formatDuration(190_000), "3 min 10 s");
  assertEquals(formatDuration(120_000), "2 min");
  assertEquals(formatDuration(65 * 60_000), "1 h 5 min");
  assertEquals(measureList([5]), "measure 5");
  assertEquals(measureList([5, 9]), "measures 5 and 9");
  assertEquals(measureList([5, 6, 9]), "measures 5, 6 and 9");
});
