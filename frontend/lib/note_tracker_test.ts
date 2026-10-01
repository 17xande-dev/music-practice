import { assert, assertEquals } from "@std/assert";
import type { NoteEvent } from "./engine.ts";
import { NoteTracker, onsetStrength, type TimedFrame, velocityFor } from "./note_tracker.ts";
import { dbToAmplitude, PitchDetector } from "./pitch.ts";
import { midiToFreq, pluckSequence } from "./pluck.ts";

// ---- Frame-level behaviour ------------------------------------------------

const HOP_MS = 5;
/** A run of frames at one pitch and level. midi null = unpitched. */
function frames(
  t0: number,
  n: number,
  midi: number | null,
  db: number,
  clarity = 0.97,
): TimedFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * HOP_MS,
    freq: midi === null ? 0 : midiToFreq(midi),
    clarity: midi === null ? 0.2 : clarity,
    rms: dbToAmplitude(db),
  }));
}

function run(tracker: NoteTracker, fs: TimedFrame[]): NoteEvent[] {
  return fs.flatMap((f) => tracker.push(f));
}

const summary = (evs: NoteEvent[]) => evs.map((e) => `${e.type}${e.midi}@${e.t}`);

Deno.test("a pluck: one note-on stamped at the attack, one note-off when it dies", () => {
  const tr = new NoteTracker();
  const evs = run(tr, [
    ...frames(0, 5, null, -70), // silence
    ...frames(25, 2, null, -20), // attack: pick noise, no clear pitch yet
    ...frames(35, 20, 52, -20), // the note
    ...frames(135, 5, null, -70), // decayed away
  ]);
  assertEquals(summary(evs), ["on52@25", "off52@135"]);
});

Deno.test("a pitch must hold for a few frames before it counts", () => {
  const tr = new NoteTracker();
  // Silence, a pluck (pick noise), then the pitch once the window has turned
  // over: two frames are not yet a note; the third is, stamped at the pluck.
  const evs = run(tr, [
    ...frames(0, 2, null, -70),
    ...frames(10, 5, null, -20),
    ...frames(40, 2, 52, -20),
  ]);
  assertEquals(evs, []);
  assertEquals(summary(run(tr, frames(50, 1, 52, -20))), ["on52@10"]);
});

Deno.test("re-plucking the same note gives a new note", () => {
  const tr = new NoteTracker();
  const evs = run(tr, [
    ...frames(0, 3, null, -70),
    ...frames(15, 30, 57, -18),
    ...frames(165, 4, 57, -30), // decaying
    ...frames(185, 30, 57, -16), // plucked again: +14 dB
  ]);
  assertEquals(summary(evs), ["on57@15", "off57@185", "on57@185"]);
});

Deno.test("a legato change of pitch ends one note and starts the next", () => {
  const tr = new NoteTracker();
  const evs = run(tr, [
    ...frames(0, 3, null, -70),
    ...frames(15, 20, 55, -20),
    ...frames(115, 20, 57, -22), // hammer-on: no new attack, pitch moves
  ]);
  assertEquals(summary(evs), ["on55@15", "off55@115", "on57@115"]);
});

Deno.test("brief octave flickers inside a note are ignored", () => {
  const tr = new NoteTracker();
  const evs = run(tr, [
    ...frames(0, 3, null, -70),
    ...frames(15, 20, 45, -20),
    ...frames(115, 4, 57, -24), // 4 frames an octave up: a detector flicker
    ...frames(135, 20, 45, -25),
  ]);
  assertEquals(summary(evs), ["on45@15"]);
});

Deno.test("the gate has hysteresis, so a note fading near the threshold doesn't chatter", () => {
  const tr = new NoteTracker({ gateOnDb: -45, gateOffDb: -52 });
  const evs = run(tr, [
    ...frames(0, 3, null, -70),
    ...frames(15, 10, 50, -30),
    ...frames(65, 6, 50, -48), // under gate-on, over gate-off: still sounding
    ...frames(95, 3, 50, -60), // through gate-off: ends
  ]);
  assertEquals(summary(evs), ["on50@15", "off50@95"]);
});

Deno.test("unclear frames neither start nor end a note", () => {
  const tr = new NoteTracker();
  const evs = run(tr, [
    ...frames(0, 3, null, -70),
    ...frames(15, 10, 48, -20, 0.5), // loud but unclear: noise, not a note
  ]);
  assertEquals(evs, []);
});

Deno.test("velocity follows level", () => {
  assertEquals(velocityFor(-50), 1);
  assertEquals(velocityFor(-6), 127);
  assert(velocityFor(-20) > velocityFor(-35));
  assertEquals(velocityFor(0), 127);
});

// ---- End to end: synthesised audio → detector → tracker --------------------

const SR = 48000;
const N = 2048;
const HOP = 256;

/** Run audio through detector and tracker exactly as the worklet will. */
function transcribe(audio: Float32Array): NoteEvent[] {
  const det = new PitchDetector(N, SR);
  const tr = new NoteTracker();
  const evs: NoteEvent[] = [];
  for (let end = N; end <= audio.length; end += HOP) {
    const win = audio.subarray(end - N, end);
    const f = det.detect(win);
    evs.push(...tr.push({ ...f, t: (end / SR) * 1000, onset: onsetStrength(win) }));
  }
  evs.push(...tr.flush((audio.length / SR) * 1000));
  return evs;
}

Deno.test("end to end: a C major scale on guitar comes out note for note", () => {
  // C3 to C4 and back, a note every 400 ms.
  const up = [48, 50, 52, 53, 55, 57, 59, 60];
  const midis = [...up, ...up.slice(0, -1).reverse()];
  const evs = transcribe(pluckSequence(midis, SR, 0.4, { seconds: 0.6 }));
  const ons = evs.filter((e) => e.type === "on");
  assertEquals(ons.map((e) => e.midi), midis);
  // Each onset lands within one window of the pluck (window latency).
  ons.forEach((e, i) => {
    const late = e.t - i * 400;
    assert(late >= 0 && late < 60, `note ${i}: ${late.toFixed(1)} ms after its pluck`);
  });
  // Notes alternate on/off cleanly: never two notes sounding at once.
  let sounding = 0;
  for (const e of evs) {
    sounding += e.type === "on" ? 1 : -1;
    assert(sounding === 0 || sounding === 1, "overlapping notes");
  }
});

Deno.test("end to end: the same note plucked three times is three notes", () => {
  const evs = transcribe(pluckSequence([45, 45, 45], SR, 0.5, { seconds: 0.7 }));
  assertEquals(evs.filter((e) => e.type === "on").map((e) => e.midi), [45, 45, 45]);
});

Deno.test("end to end: low E and high frets both track", () => {
  const midis = [40, 41, 76, 88, 40];
  const evs = transcribe(pluckSequence(midis, SR, 0.45, { seconds: 0.6 }));
  assertEquals(evs.filter((e) => e.type === "on").map((e) => e.midi), midis);
});

// A G major scale up and down in 16ths at 120 BPM. Scales never repeat a
// pitch back to back (the turn at the top doesn't repeat it), which matters:
// a same-note re-pluck this fast is masked by the still-ringing note and
// isn't detected. Slower re-plucks are (see above).
Deno.test("end to end: 16th notes at 120 BPM (125 ms apart) still track", () => {
  const midis = [55, 57, 59, 60, 62, 64, 66, 67, 66, 64, 62, 60, 59, 57, 55];
  const evs = transcribe(pluckSequence(midis, SR, 0.125, { seconds: 0.3 }));
  const ons = evs.filter((e) => e.type === "on");
  assertEquals(ons.map((e) => e.midi), midis);
  ons.forEach((e, i) => {
    const late = e.t - i * 125;
    assert(late >= 0 && late < 60, `note ${i}: ${late.toFixed(1)} ms late`);
  });
});
