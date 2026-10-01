import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { FFT } from "./fft.ts";
import { amplitudeToDb, dbToAmplitude, freqToMidi, PitchDetector } from "./pitch.ts";
import { midiToFreq, pluck } from "./pluck.ts";

const SR = 48000;
const N = 2048;

const cents = (detected: number, expected: number) => 1200 * Math.log2(detected / expected);

/** A window starting `offset` seconds into the signal. */
const windowAt = (sig: Float32Array, offset: number) => {
  const start = Math.round(offset * SR);
  return sig.slice(start, start + N);
};

Deno.test("FFT matches a naive DFT, forward and inverse", () => {
  const n = 64;
  const fft = new FFT(n);
  const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  fft.transform(re, im);
  for (let k = 0; k < n; k++) {
    let dr = 0, di = 0;
    for (let t = 0; t < n; t++) {
      dr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      di -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    assertAlmostEquals(re[k], dr, 1e-9);
    assertAlmostEquals(im[k], di, 1e-9);
  }
  fft.transform(re, im, true);
  for (let t = 0; t < n; t++) assertAlmostEquals(re[t] / n, x[t], 1e-9);
  assertThrows(() => new FFT(48));
});

Deno.test("dB conversion is amplitude (/20), not power (/10) as in pitchy", () => {
  assertAlmostEquals(dbToAmplitude(-20), 0.1, 1e-12);
  assertAlmostEquals(dbToAmplitude(-40), 0.01, 1e-12);
  assertAlmostEquals(amplitudeToDb(0.5), -6.0206, 1e-3);
  assertEquals(amplitudeToDb(0), -Infinity);
});

Deno.test("pure sines across the guitar range, within 2 cents", () => {
  const d = new PitchDetector(N, SR);
  for (const f of [82.41, 110, 146.83, 196, 246.94, 329.63, 659.25, 1318.5]) {
    const w = Float32Array.from(
      { length: N },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / SR),
    );
    const r = d.detect(w);
    assert(Math.abs(cents(r.freq, f)) < 2, `${f} Hz -> ${r.freq}`);
    assert(r.clarity > 0.95);
  }
});

// Every note on a 24-fret guitar in standard tuning: open low E to the 24th
// fret of the high E (MIDI 40–88), as synthetic plucks. The window starts
// 60 ms in, after the pick noise.
Deno.test("every guitar note E2–E6 as a pluck: right note, within 10 cents", () => {
  const d = new PitchDetector(N, SR);
  let checked = 0;
  for (let midi = 40; midi <= 88; midi++) {
    const f = midiToFreq(midi);
    const r = d.detect(windowAt(pluck(f, SR, { seconds: 0.25, seed: midi }), 0.06));
    assertEquals(Math.round(freqToMidi(r.freq)), midi, `MIDI ${midi}: ${r.freq.toFixed(1)} Hz`);
    // Inharmonicity stretches the partials slightly sharp; still close.
    assert(Math.abs(cents(r.freq, f)) < 10, `MIDI ${midi}: ${cents(r.freq, f).toFixed(1)} cents`);
    checked++;
  }
  assertEquals(checked, 49);
});

// A neck pickup's sound can put more energy in the 2nd harmonic than the
// fundamental. MPM must still report the fundamental, not an octave up.
Deno.test("a strong 2nd harmonic does not cause an octave-up error", () => {
  const d = new PitchDetector(N, SR);
  for (const midi of [40, 45, 52, 57, 64]) {
    const sig = pluck(midiToFreq(midi), SR, {
      seconds: 0.25,
      harmonics: [0.5, 1, 0.4, 0.3, 0.2, 0.1],
    });
    const r = d.detect(windowAt(sig, 0.06));
    assertEquals(Math.round(freqToMidi(r.freq)), midi, `MIDI ${midi}: ${r.freq.toFixed(1)}`);
  }
});

// Without a range, a lobe at twice the period can win and read an octave
// low. The guitar range rules out anything below ~70 Hz.
Deno.test("nothing below the minimum frequency is ever reported", () => {
  const d = new PitchDetector(N, SR, { minHz: 70, maxHz: 1400 });
  const f = 60; // below the range
  const w = Float32Array.from({ length: N }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / SR));
  const r = d.detect(w);
  assert(r.freq === 0 || r.freq >= 70, `got ${r.freq}`);
});

Deno.test("silence and quiet noise are gated; loud noise has low clarity", () => {
  const d = new PitchDetector(N, SR, { minRmsDb: -60 });
  assertEquals(d.detect(new Float32Array(N)).freq, 0);
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const quiet = Float32Array.from({ length: N }, () => 0.0005 * rand());
  assertEquals(d.detect(quiet).freq, 0); // ≈ −66 dBFS: under the gate
  const loud = Float32Array.from({ length: N }, () => 0.3 * rand());
  const r = d.detect(loud);
  assert(r.clarity < 0.8, `noise clarity ${r.clarity}`);
});

Deno.test("reports the window's RMS", () => {
  const d = new PitchDetector(N, SR);
  const w = Float32Array.from(
    { length: N },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR),
  );
  assertAlmostEquals(d.detect(w).rms, 0.5 / Math.SQRT2, 0.01);
  assertThrows(() => d.detect(new Float32Array(100)));
});
