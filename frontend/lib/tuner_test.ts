import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { NoteTracker } from "./note_tracker.ts";
import { dbToAmplitude } from "./pitch.ts";
import {
  againstString,
  centsBetween,
  nearestString,
  noteFreq,
  tuneAdvice,
  TunerSmoother,
  tuneState,
} from "./tuner.ts";

const detune = (f: number, cents: number) => f * 2 ** (cents / 1200);

Deno.test("note frequencies follow the reference pitch", () => {
  assertAlmostEquals(noteFreq(69), 440, 1e-9);
  assertAlmostEquals(noteFreq(40), 82.407, 1e-3); // low E
  assertAlmostEquals(noteFreq(69, 432), 432, 1e-9);
  assertAlmostEquals(centsBetween(detune(110, 12), 110), 12, 1e-9);
});

Deno.test("each open string, in tune and detuned, is recognised with the right offset", () => {
  const strings = [40, 45, 50, 55, 59, 64];
  strings.forEach((midi, s) => {
    for (const off of [0, -30, 25, -45]) {
      const r = nearestString(detune(noteFreq(midi), off));
      assertEquals(r.string, s, `string ${s} at ${off}¢`);
      assertAlmostEquals(r.cents, off, 1e-6);
    }
  });
});

// A slack string can be well over a semitone flat. Nearest-string matching
// still finds it, so the tuner says "tune up", not the wrong string.
Deno.test("a string a whole tone flat still maps to its own string", () => {
  const r = nearestString(detune(noteFreq(45), -200)); // A string down to G
  assertEquals(r.string, 1);
  assertAlmostEquals(r.cents, -200, 1e-6);
});

Deno.test("locking a string measures against it, however far off", () => {
  const r = againstString(detune(noteFreq(50), 300), 2);
  assertEquals(r.string, 2);
  assertAlmostEquals(r.cents, 300, 1e-6);
});

Deno.test("a guitar tuned to A = 432 reads in tune with the reference set to 432", () => {
  const lowE432 = noteFreq(40, 432);
  assert(Math.abs(nearestString(lowE432, 440).cents) > 25); // ~32¢ flat at 440
  assertAlmostEquals(nearestString(lowE432, 432).cents, 0, 1e-6);
});

Deno.test("tune states and advice", () => {
  assertEquals(tuneState(3), "in-tune");
  assertEquals(tuneState(-5), "in-tune");
  assertEquals(tuneState(-12), "close");
  assertEquals(tuneState(-30), "flat");
  assertEquals(tuneState(40), "sharp");
  assertEquals(tuneAdvice(-30), "Flat: tune up");
  assertEquals(tuneAdvice(40), "Sharp: tune down");
  assertEquals(tuneAdvice(1), "In tune");
});

Deno.test("the smoother ignores a stray octave frame and holds briefly when the note fades", () => {
  const s = new TunerSmoother(5, 600);
  let shown: number | null = null;
  for (let i = 0; i < 5; i++) shown = s.push(110, i * 5);
  shown = s.push(220, 25); // one octave error
  assertAlmostEquals(shown!, 110, 1e-6);
  shown = s.push(0, 100); // fading: held
  assertAlmostEquals(shown!, 110, 1e-6);
  assertEquals(s.push(0, 800), null); // gone
});

// The note tracker takes the same reference, so grading agrees with the tuner.
Deno.test("the note tracker grades against the reference pitch", () => {
  const onsFor = (freq: number, a4: number) => {
    const tr = new NoteTracker({ a4 });
    const evs = [];
    for (let i = 0; i < 8; i++) {
      evs.push(...tr.push({ t: i * 5, freq, clarity: 0.98, rms: dbToAmplitude(-20) }));
    }
    return evs.filter((e) => e.type === "on").map((e) => e.midi);
  };
  // 104 Hz is A2 on a guitar tuned to A4 = 416, but G♯2 at the standard 440.
  assertEquals(onsFor(104, 440), [44]);
  assertEquals(onsFor(104, 416), [45]);
});
