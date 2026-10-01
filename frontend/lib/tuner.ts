// The guitar tuner's logic: which string you're tuning, how far off it is,
// and which way to turn. Pure, so it is tested without audio.
//
// Tuning matters to grading. Notes are rounded to the nearest semitone, so a
// string 30 cents flat still reads correctly, but one half a semitone out
// reads as its neighbour. A whole guitar tuned to another reference (A = 432)
// shifts every note; the reference pitch below handles that without
// retuning, and the note tracker uses the same value.

import { STANDARD_TUNING } from "./guitar.ts";

export const DEFAULT_A4 = 440;
export const MIN_A4 = 415; // a semitone flat of 440: baroque pitch
export const MAX_A4 = 466; // a semitone sharp

/** Equal-tempered frequency of a MIDI note for a given A4. */
export function noteFreq(midi: number, a4 = DEFAULT_A4): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

/** Cents from `target` Hz to `freq` Hz (positive = sharp). */
export function centsBetween(freq: number, target: number): number {
  return 1200 * Math.log2(freq / target);
}

export interface StringReading {
  /** 0 = low E … 5 = high e. */
  string: number;
  target: number;
  cents: number;
}

/**
 * The open string `freq` is closest to, in cents. A string being tuned can
 * be far off, a whole tone or more, so this compares against the open
 * strings themselves rather than rounding to the nearest semitone first.
 */
export function nearestString(
  freq: number,
  a4 = DEFAULT_A4,
  tuning = STANDARD_TUNING,
): StringReading {
  let best: StringReading = { string: 0, target: noteFreq(tuning[0], a4), cents: Infinity };
  tuning.forEach((midi, string) => {
    const target = noteFreq(midi, a4);
    const cents = centsBetween(freq, target);
    if (Math.abs(cents) < Math.abs(best.cents)) best = { string, target, cents };
  });
  return best;
}

/** The reading against one chosen string (when the player locks a string). */
export function againstString(
  freq: number,
  string: number,
  a4 = DEFAULT_A4,
  tuning = STANDARD_TUNING,
): StringReading {
  const target = noteFreq(tuning[string], a4);
  return { string, target, cents: centsBetween(freq, target) };
}

export type TuneState = "in-tune" | "close" | "flat" | "sharp";

/**
 * ±5 cents is in tune, about what a good ear can hear. Within ±15 counts as
 * close. Beyond that, flat or sharp says which way to turn the peg.
 */
export function tuneState(cents: number): TuneState {
  const a = Math.abs(cents);
  if (a <= 5) return "in-tune";
  if (a <= 15) return "close";
  return cents < 0 ? "flat" : "sharp";
}

export function tuneAdvice(cents: number): string {
  switch (tuneState(cents)) {
    case "in-tune":
      return "In tune";
    case "close":
      return cents < 0 ? "Nearly there: a touch up" : "Nearly there: a touch down";
    case "flat":
      return "Flat: tune up";
    case "sharp":
      return "Sharp: tune down";
  }
}

/**
 * Steadies the needle. Each reading is one detector frame (~5 ms), and a
 * plucked string's pitch wobbles at the attack and as it decays. The
 * smoother shows the median of the last few frequencies (in log space, so a
 * stray octave error can't drag it), and holds the last value for a moment
 * when the note fades, so the needle doesn't snap to nothing mid-glance.
 */
export class TunerSmoother {
  private recent: number[] = [];
  private last: number | null = null;
  private lastT = -Infinity;

  constructor(private readonly size = 9, private readonly holdMs = 600) {}

  /** Feed one frame (freq 0 when there is no clear pitch); returns the shown Hz or null. */
  push(freq: number, t: number): number | null {
    if (freq > 0) {
      this.recent.push(Math.log2(freq));
      if (this.recent.length > this.size) this.recent.shift();
      const sorted = [...this.recent].sort((a, b) => a - b);
      this.last = 2 ** sorted[sorted.length >> 1];
      this.lastT = t;
      return this.last;
    }
    if (t - this.lastT > this.holdMs) {
      this.recent = [];
      this.last = null;
    }
    return this.last;
  }

  reset() {
    this.recent = [];
    this.last = null;
    this.lastT = -Infinity;
  }
}
