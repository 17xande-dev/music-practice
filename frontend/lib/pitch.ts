// Monophonic pitch detection with the McLeod Pitch Method (MPM): the
// algorithm most instrument tuners use, and the one pitchy implements.
//
// Ported closely from pitchy (https://github.com/ianprime0509/pitchy),
// Copyright 2018-2021 Ian Johnson, MIT licence:
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the
//   following conditions: The above copyright notice and this permission
//   notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Changes from pitchy, for guitar and for running in the audio thread:
//   - The search is limited to a frequency range (guitar: 70–1400 Hz). pitchy
//     considers every lag, so a strong sub-harmonic lobe can win and report a
//     note an octave or more too low.
//   - Decibels convert to amplitude with 10^(dB/20). pitchy's
//     minVolumeDecibels uses 10^(dB/10), the power formula, so its gate sits
//     at half the intended dB value.
//   - Nothing allocates per call: buffers, key-maximum indices and the FFT are
//     made once. Garbage collection in the audio thread causes dropouts.
//   - The RMS level is returned with the pitch; the note tracker needs it for
//     onsets and velocity.
//   - fft.js is replaced by ./fft.ts.

import { FFT } from "./fft.ts";

export interface PitchFrame {
  /** Hz, or 0 when there is no clear pitch (silence, noise, gate closed). */
  freq: number;
  /** 0–1: how periodic the window is. ≥ ~0.9 is a clearly pitched note. */
  clarity: number;
  /** Root-mean-square level of the window, 0–1. */
  rms: number;
}

export interface DetectorOptions {
  minHz?: number;
  maxHz?: number;
  /** MPM's k: pick the first key maximum ≥ k × the highest one. */
  clarityThreshold?: number;
  /** Windows quieter than this are not analysed. */
  minRmsDb?: number;
}

/** Amplitude for a level in dBFS. (pitchy divides by 10 here; amplitude is /20.) */
export function dbToAmplitude(db: number): number {
  return 10 ** (db / 20);
}

export function amplitudeToDb(a: number): number {
  return a > 0 ? 20 * Math.log10(a) : -Infinity;
}

/** MIDI note number (fractional) for a frequency, A4 = 440 Hz. */
export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export class PitchDetector {
  readonly windowSize: number;
  readonly sampleRate: number;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly nsdf: Float64Array;
  private readonly keys: Int32Array;
  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly k: number;
  private readonly minRms: number;

  constructor(windowSize: number, sampleRate: number, opts: DetectorOptions = {}) {
    this.windowSize = windowSize;
    this.sampleRate = sampleRate;
    // Zero-padding to twice the window makes the FFT's circular
    // autocorrelation equal the linear one for every lag we read.
    let size = 1;
    while (size < 2 * windowSize) size <<= 1;
    this.fft = new FFT(size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.nsdf = new Float64Array(windowSize);
    this.keys = new Int32Array(windowSize);
    const maxHz = opts.maxHz ?? 1400;
    const minHz = opts.minHz ?? 70;
    this.minLag = Math.max(2, Math.floor(sampleRate / maxHz));
    // NSDF values become unreliable past half the window (too few terms).
    this.maxLag = Math.min(Math.ceil(sampleRate / minHz), Math.floor(windowSize / 2));
    this.k = opts.clarityThreshold ?? 0.9;
    this.minRms = dbToAmplitude(opts.minRmsDb ?? -60);
  }

  detect(input: Float32Array | Float64Array): PitchFrame {
    const n = this.windowSize;
    if (input.length !== n) {
      throw new RangeError(`input must have ${n} samples, got ${input.length}`);
    }
    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += input[i] * input[i];
    const rms = Math.sqrt(sumSq / n);
    if (rms < this.minRms) return { freq: 0, clarity: 0, rms };

    this.computeNsdf(input);

    // Key maxima: the highest point of each positive lobe (between a rising
    // and a falling zero crossing), as in pitchy, but only lobes that peak
    // inside the allowed lag range.
    const nsdf = this.nsdf;
    let count = 0;
    let looking = false;
    let max = -Infinity;
    let maxIdx = -1;
    const end = Math.min(n - 1, this.maxLag + 1);
    for (let i = 1; i < end; i++) {
      if (nsdf[i - 1] <= 0 && nsdf[i] > 0) {
        looking = true;
        max = nsdf[i];
        maxIdx = i;
      } else if (nsdf[i - 1] > 0 && nsdf[i] <= 0) {
        looking = false;
        if (maxIdx >= this.minLag && maxIdx <= this.maxLag) this.keys[count++] = maxIdx;
        maxIdx = -1;
      } else if (looking && nsdf[i] > max) {
        max = nsdf[i];
        maxIdx = i;
      }
    }
    // A lobe still open at the end of the range counts only if it has
    // already peaked: a point that is merely the last one examined, still
    // rising, is not a maximum, and interpolating there extrapolates wildly
    // (a 60 Hz tone came out as 54 Hz with a 70 Hz floor).
    if (
      looking && maxIdx >= this.minLag && maxIdx < end - 1 && nsdf[maxIdx] >= nsdf[maxIdx + 1]
    ) {
      this.keys[count++] = maxIdx;
    }
    if (count === 0) return { freq: 0, clarity: 0, rms };

    let nMax = -Infinity;
    for (let j = 0; j < count; j++) nMax = Math.max(nMax, nsdf[this.keys[j]]);
    let chosen = this.keys[0];
    for (let j = 0; j < count; j++) {
      if (nsdf[this.keys[j]] >= this.k * nMax) {
        chosen = this.keys[j];
        break;
      }
    }
    const [lag, clarity] = refine(chosen, nsdf);
    return { freq: this.sampleRate / lag, clarity: Math.min(clarity, 1), rms };
  }

  /**
   * The normalised square difference function, nsdf(τ) = 2r(τ) / m(τ):
   * r from an FFT autocorrelation, m updated incrementally (MPM paper §6,
   * following pitchy line for line).
   */
  private computeNsdf(input: Float32Array | Float64Array) {
    const n = this.windowSize;
    const { re, im, nsdf } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n; i++) re[i] = input[i];
    this.fft.transform(re, im);
    for (let i = 0; i < re.length; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    this.fft.transform(re, im, true);
    const scale = 1 / re.length;
    for (let i = 0; i < n; i++) nsdf[i] = re[i] * scale;

    let m = 2 * nsdf[0];
    let i = 0;
    for (; i < n && m > 0; i++) {
      nsdf[i] = (2 * nsdf[i]) / m;
      m -= input[i] * input[i] + input[n - i - 1] * input[n - i - 1];
    }
    for (; i < n; i++) nsdf[i] = 0;
  }
}

/** Parabolic interpolation through the peak and its neighbours (as pitchy). */
function refine(i: number, data: Float64Array): [lag: number, value: number] {
  const y0 = data[i - 1];
  const y1 = data[i];
  const y2 = data[i + 1];
  const a = (y0 + y2) / 2 - y1;
  if (a === 0) return [i, y1];
  const b = (y2 - y0) / 2;
  // A true peak's vertex lies within half a sample; clamp in case it isn't.
  const x = Math.max(-1, Math.min(1, -b / (2 * a)));
  return [i + x, y1 + b * x + a * x * x];
}
