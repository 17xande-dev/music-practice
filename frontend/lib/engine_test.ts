import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { NOT_TOGETHER_MS, NotesEngine, TempoEngine } from "./engine.ts";
import { buildSteps, type Step } from "./theory.ts";

// C major, one octave up, right hand: 60 62 64 65 67 69 71 72.
const cMajor = (hands: "rh" | "both" = "rh"): Step[] =>
  buildSteps({
    tonic: { letter: "C", acc: 0 },
    type: "major",
    octaves: 1,
    direction: "up",
    hands,
  });

const on = (midi: number, t: number, velocity = 80) => ({
  type: "on" as const,
  midi,
  t,
  velocity,
});
const off = (midi: number, t: number) => ({
  type: "off" as const,
  midi,
  t,
  velocity: 0,
});

Deno.test("notes: a clean run scores 100%", () => {
  const steps = cMajor();
  const e = new NotesEngine(steps);
  steps.forEach((s, i) => {
    const f = e.input(on(s.notes[0].midi, i * 500));
    assertEquals(f, {
      kind: "correct",
      midi: s.notes[0].midi,
      step: i,
      stepDone: true,
    });
    e.input(off(s.notes[0].midi, i * 500 + 400));
  });
  assert(e.done);
  const s = e.summary();
  assertEquals([s.total, s.correct, s.accuracy, s.wrongNotes], [8, 8, 1, 0]);
  assertEquals(s.durationMs, 3500);
  assertEquals(s.unevenness, 0); // perfectly even gaps
  assertEquals(s.timing, null);
});

Deno.test("notes: a wrong note holds the cursor and costs that step", () => {
  const e = new NotesEngine(cMajor());
  e.input(on(60, 0));
  assertEquals(e.input(on(63, 100)), { kind: "wrong", midi: 63, step: 1 });
  assertEquals(e.cursor, 1);
  assertEquals(e.input(on(62, 200)).kind, "correct");
  assertEquals(e.cursor, 2);
  const s = e.summary();
  assertEquals(s.wrongNotes, 1);
  assertEquals(e.results[1].wrong, [63]);
  assertEquals(e.results[1].clean, false);
  assertEquals(e.results[1].status, "ok");
});

Deno.test("notes: repeats and note-offs are ignored, input after the end too", () => {
  const steps = cMajor("both");
  const e = new NotesEngine(steps);
  e.input(on(60, 0));
  assertEquals(e.input(on(60, 10)).kind, "ignored"); // RH again before LH
  assertEquals(e.input(off(60, 20)).kind, "ignored");
  assertEquals(e.cursor, 0);
  e.input(on(48, 30));
  assertEquals(e.cursor, 1);
  for (const s of steps.slice(1)) {
    for (const n of s.notes) e.input(on(n.midi, 100));
  }
  assert(e.done);
  assertEquals(e.input(on(72, 999)).kind, "ignored");
  assertEquals(e.summary().wrongNotes, 0);
});

Deno.test("notes: hands together completes on both notes in either order and measures asynchrony", () => {
  const e = new NotesEngine(cMajor("both"));
  assertEquals(e.input(on(48, 1000)), {
    kind: "correct",
    midi: 48,
    step: 0,
    stepDone: false,
  });
  assertEquals(e.input(on(60, 1030)), {
    kind: "correct",
    midi: 60,
    step: 0,
    stepDone: true,
  });
  assertEquals(e.results[0].asyncMs, 30);
  e.input(on(62, 2000));
  e.input(on(50, 2000 + NOT_TOGETHER_MS + 1));
  assertEquals(e.summary().notTogether, 1);
});

Deno.test("notes: one hesitation barely moves unevenness; ragged spacing does", () => {
  const run = (times: number[], vels = times.map(() => 80)) => {
    const e = new NotesEngine(cMajor());
    cMajor().forEach((s, i) => e.input(on(s.notes[0].midi, times[i], vels[i])));
    return e.summary();
  };
  // Steady 400 ms apart except one 3 s pause to find a note.
  const hesitant = run([0, 400, 800, 3800, 4200, 4600, 5000, 5400]);
  assertEquals(hesitant.unevenness, 0);
  // Gaps alternating 200/600: never steady.
  const ragged = run([0, 200, 800, 1000, 1600, 1800, 2400, 2600]);
  assert(ragged.unevenness! >= 0.5, `unevenness ${ragged.unevenness}`);
  const s = run([0, 400, 800, 1200, 1600, 2000, 2400, 2800], [60, 100, 60, 100, 60, 100, 60, 100]);
  assertEquals(s.velocityStd, 20);
});

// Tempo: 120 bpm, one note per beat → one step every 500 ms from t=1000.
const tempo = (steps = cMajor(), latencyMs = 0) =>
  new TempoEngine(steps, {
    bpm: 120,
    notesPerBeat: 1,
    startTime: 1000,
    latencyMs,
  });

Deno.test("tempo: grades on-time, early and late against the tolerance", () => {
  const e = tempo();
  assertEquals(e.interval, 500);
  assertEquals(e.tolerance, 60);
  e.input(on(60, 1000)); // on the beat
  e.input(on(62, 1500 - 100)); // 100 early
  e.input(on(64, 2000 + 150)); // 150 late
  e.input(on(65, 2500 + 59)); // just inside
  assertEquals(e.results.slice(0, 4).map((r) => r.grade), [
    "on",
    "early",
    "late",
    "on",
  ]);
  assertEquals(e.results[1].deviationMs, -100);
});

Deno.test("tempo: unplayed windows become misses on tick, and the summary counts them", () => {
  const e = tempo();
  e.input(on(60, 1000));
  // Nothing for step 1. Its window closes at 1500 + 250.
  assertEquals(e.tick(1700), [0]);
  assertEquals(e.tick(1751), [1]);
  assertEquals(e.results[1].status, "missed");
  // A note for step 1 arriving now lands in step 2's window and is wrong there.
  assertEquals(e.input(on(62, 1760)), { kind: "wrong", midi: 62, step: 2 });
  e.tick(e.endTime + 1);
  assert(e.done);
  const s = e.summary();
  assertEquals(s.correct, 1);
  assertEquals(s.timing!.missed, 7);
  assertEquals(s.timing!.onTime, 1);
  assertEquals(s.durationMs, 3750);
});

Deno.test("tempo: a note in a closed window counts as wrong, not as a late hit", () => {
  const e = tempo();
  e.tick(1800); // closes steps 0 and 1
  assertEquals(e.input(on(62, 1740)).kind, "wrong"); // step 1's window, already closed
  assertEquals(e.results[1].status, "missed");
});

Deno.test("tempo: latency offset is subtracted before grading", () => {
  const e = tempo(cMajor(), 40);
  e.input(on(60, 1040)); // arrives 40 ms after the beat because of the chain
  assertEquals(e.results[0].deviationMs, 0);
  assertEquals(e.results[0].grade, "on");
});

Deno.test("tempo: tolerance shrinks at fast subdivisions", () => {
  const e = new TempoEngine(cMajor(), {
    bpm: 160,
    notesPerBeat: 4,
    startTime: 0,
  });
  assertAlmostEquals(e.interval, 93.75);
  assertAlmostEquals(e.tolerance, 93.75 / 4);
});

Deno.test("tempo: half a hands-together step is a miss", () => {
  const e = tempo(cMajor("both"));
  e.input(on(60, 1000));
  e.tick(1300);
  assertEquals(e.results[0].status, "missed");
  const s = e.summary();
  assertEquals(s.timing!.missed, 8);
});

Deno.test("tempo: mean signed deviation shows rushing", () => {
  const e = tempo();
  cMajor().forEach((s, i) => e.input(on(s.notes[0].midi, 1000 + i * 500 - 30)));
  e.tick(e.endTime + 1);
  const t = e.summary().timing!;
  assertEquals(t.meanSignedMs, -30);
  assertEquals(t.meanAbsMs, 30);
  assertEquals(t.onTime, 8);
  assertEquals(e.summary().accuracy, 1);
});

// Songs: steps at uneven times. Quarter, quarter, eighth, eighth, half at
// 120 BPM: due at 0, 500, 1000, 1250, 1500 ms.
const UNEVEN = [0, 500, 1000, 1250, 1500];

Deno.test("tempo with offsets: each step is due at its own time", () => {
  const steps = cMajor().slice(0, 5);
  const e = new TempoEngine(steps, { bpm: 120, notesPerBeat: 1, startTime: 1000, offsets: UNEVEN });
  assertEquals(UNEVEN.map((_, i) => e.dueAt(i)), [1000, 1500, 2000, 2250, 2500]);
  steps.forEach((s, i) => e.input(on(s.notes[0].midi, e.dueAt(i) + 10)));
  assert(e.results.every((r) => r.status === "ok" && r.grade === "on"));
  assertEquals(e.interval, 375); // median gap
});

Deno.test("tempo with offsets: windows reach half way to each neighbour", () => {
  const steps = cMajor().slice(0, 5);
  const e = new TempoEngine(steps, { bpm: 120, notesPerBeat: 1, startTime: 0, offsets: UNEVEN });
  assertEquals(e.stepAt(-251), -1);
  assertEquals(e.stepAt(-240), 0);
  assertEquals(e.stepAt(249), 0);
  assertEquals(e.stepAt(251), 1);
  assertEquals(e.stepAt(1120), 2); // eighths: the boundary is at 1125
  assertEquals(e.stepAt(1130), 3);
  assertEquals(e.stepAt(1630), 5); // past the last window (1500 + 125)
  // A note 100 ms late on the first eighth still belongs to it, but is late.
  e.input(on(64, 1100));
  assertEquals(e.results[2].grade, "late");
});

Deno.test("tempo with offsets: tolerance shrinks around short notes only", () => {
  // Two quarters at 120 BPM, then 32nds (62.5 ms apart).
  const e = new TempoEngine(cMajor().slice(0, 5), {
    bpm: 120,
    notesPerBeat: 1,
    startTime: 0,
    offsets: [0, 500, 1000, 1062.5, 1125],
  });
  assertEquals(e.toleranceAt(0), 60);
  assertEquals(e.toleranceAt(1), 60);
  assertEquals(e.toleranceAt(2), 62.5 / 4); // the short gap after it counts
  assertEquals(e.toleranceAt(4), 62.5 / 4);
});

Deno.test("tempo with offsets: missed steps close at their own window end", () => {
  const e = new TempoEngine(cMajor().slice(0, 5), {
    bpm: 120,
    notesPerBeat: 1,
    startTime: 0,
    offsets: UNEVEN,
  });
  assertEquals(e.tick(1124), [0, 1]);
  assertEquals(e.tick(1126), [2]);
  assertEquals(e.tick(2000), [3, 4]);
  assert(e.done);
});

Deno.test("tempo with offsets: rejects a bad offset list", () => {
  const steps = cMajor().slice(0, 3);
  let threw = 0;
  for (const offsets of [[0, 100], [0, 100, 100]]) {
    try {
      new TempoEngine(steps, { bpm: 60, notesPerBeat: 1, startTime: 0, offsets });
    } catch {
      threw++;
    }
  }
  assertEquals(threw, 2);
});
