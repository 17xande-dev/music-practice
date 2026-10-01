// A synthetic plucked-string note, close enough to an electric guitar's DI
// signal to exercise the pitch detector and note tracker: a sharp attack,
// harmonics that decay faster the higher they are, slight inharmonicity
// (stiff strings stretch their partials), and a burst of pick noise.
//
// Used by the unit tests, and by the practice page's test hook to drive the
// real audio pipeline without a guitar plugged in.

export interface PluckOptions {
  /** Seconds of audio to produce. */
  seconds?: number;
  /** Peak level, 0–1. */
  level?: number;
  /** Harmonic amplitudes relative to the fundamental (default 1/k). */
  harmonics?: number[];
  /** String stiffness B: partial k sits at k·f·√(1 + B·k²). */
  inharmonicity?: number;
  /** Pick noise level relative to the note. */
  noise?: number;
  /** Seed for the noise, so tests are deterministic. */
  seed?: number;
}

/** Equal-tempered frequency of a MIDI note, A4 = 440 Hz. */
export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

/** A small deterministic PRNG (mulberry32), so test signals repeat exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Render one plucked note at `freq` Hz. */
export function pluck(freq: number, sampleRate: number, opts: PluckOptions = {}): Float32Array {
  const seconds = opts.seconds ?? 1;
  const level = opts.level ?? 0.5;
  const harmonics = opts.harmonics ?? Array.from({ length: 12 }, (_, k) => 1 / (k + 1));
  const B = opts.inharmonicity ?? 0.00008;
  const noiseLevel = opts.noise ?? 0.15;
  const rand = rng(opts.seed ?? 1);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const nyquist = sampleRate / 2;
  const total = harmonics.reduce((a, b) => a + Math.abs(b), 0) || 1;

  harmonics.forEach((amp, i) => {
    const k = i + 1;
    const f = k * freq * Math.sqrt(1 + B * k * k);
    if (f >= nyquist * 0.95) return;
    // Higher partials die away faster, as on a real string.
    const decay = 1.2 + 0.9 * k;
    const w = (2 * Math.PI * f) / sampleRate;
    const a = (amp / total) * level;
    for (let t = 0; t < n; t++) out[t] += a * Math.sin(w * t) * Math.exp((-decay * t) / sampleRate);
  });

  // Attack: a 2 ms ramp, plus 15 ms of decaying pick noise.
  const attack = Math.round(0.002 * sampleRate);
  const noiseLen = Math.round(0.015 * sampleRate);
  for (let t = 0; t < n; t++) {
    if (t < attack) out[t] *= t / attack;
    if (t < noiseLen) out[t] += noiseLevel * level * rand() * (1 - t / noiseLen);
  }
  return out;
}

/** A sequence of notes, each starting `spacing` seconds after the last. */
export function pluckSequence(
  midis: number[],
  sampleRate: number,
  spacing: number,
  opts: PluckOptions = {},
): Float32Array {
  const tail = opts.seconds ?? spacing;
  const n = Math.round((spacing * (midis.length - 1) + tail) * sampleRate);
  const out = new Float32Array(n);
  midis.forEach((m, i) => {
    // Each new pluck damps the previous note, as a guitarist's next note does.
    const start = Math.round(i * spacing * sampleRate);
    const note = pluck(midiToFreq(m), sampleRate, { ...opts, seconds: tail, seed: i + 1 });
    if (i > 0) {
      const damp = Math.round(0.004 * sampleRate);
      for (let t = start; t < n; t++) {
        const g = t - start < damp ? 1 - (t - start) / damp : 0;
        out[t] *= g;
      }
    }
    for (let t = 0; t < note.length && start + t < n; t++) out[start + t] += note[t];
  });
  return out;
}
