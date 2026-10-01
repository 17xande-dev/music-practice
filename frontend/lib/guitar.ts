// The guitar: standard tuning, position boxes, and where on the neck each
// note of an exercise is played.
//
// From one pickup's signal the same pitch can't be told apart on different
// strings, so the app doesn't guess: the player chooses a position (a box of
// frets), the fretboard shows the one fingering inside it, and grading is by
// pitch. Inside a box each pitch has a single place, so the fret follows.

import { pitchClass, type PitchName } from "./theory.ts";

/** Open-string MIDI notes, low E (string 6) first: E2 A2 D3 G3 B3 E4. */
export const STANDARD_TUNING: readonly number[] = [40, 45, 50, 55, 59, 64];

/** The highest fret drawn and used. */
export const MAX_FRET = 15;

/** Positions offered: 0 is open position, 1–12 put the index finger at that fret. */
export const POSITIONS = Array.from({ length: 13 }, (_, i) => i);

export interface Box {
  position: number;
  /** Frets the hand covers without moving: one per finger. */
  lo: number;
  hi: number;
  /** One fret further each way, reached with a stretch. */
  stretchLo: number;
  stretchHi: number;
}

export function boxFor(position: number): Box {
  if (position <= 0) return { position: 0, lo: 0, hi: 4, stretchLo: 0, stretchHi: 5 };
  return {
    position,
    lo: position,
    hi: position + 3,
    stretchLo: position - 1,
    stretchHi: Math.min(MAX_FRET, position + 4),
  };
}

export function positionLabel(position: number): string {
  if (position <= 0) return "Open position";
  const n = position;
  const suffix = n % 10 === 1 && n !== 11
    ? "st"
    : n % 10 === 2 && n !== 12
    ? "nd"
    : n % 10 === 3 && n !== 13
    ? "rd"
    : "th";
  return `${n}${suffix} position (frets ${n}–${n + 3})`;
}

export interface FretPosition {
  /** 0 = low E (6th string) … 5 = high e (1st string). */
  string: number;
  fret: number;
  /** False when the note had to be played outside the box. */
  inBox: boolean;
}

/**
 * Where `tonic` starts in `box`: the lowest place it can be played on the
 * three bass strings, inside the box if possible, otherwise with a stretch.
 * Three strings, not two: E and A are only five semitones apart, so their
 * two spans cover 11 pitch classes and miss one in every position (no C in
 * 10th position). With the D string every tonic is found.
 */
export function tonicMidiFor(tonic: PitchName, box: Box, tuning = STANDARD_TUNING): number {
  const pc = pitchClass(tonic);
  for (const [lo, hi] of [[box.lo, box.hi], [box.stretchLo, box.stretchHi]]) {
    let best = Infinity;
    for (const s of [0, 1, 2]) {
      for (let fret = lo; fret <= hi; fret++) {
        const midi = tuning[s] + fret;
        if (((midi % 12) + 12) % 12 === pc) best = Math.min(best, midi);
      }
    }
    if (best < Infinity) return best;
  }
  // Unreachable with standard tuning; fall back to the lowest octave on E.
  return tuning[0] + ((pc - (tuning[0] % 12) + 12) % 12);
}

/**
 * A fret and string for every distinct note of an exercise, walking up the
 * scale: stay on the current string while the note falls inside the box,
 * then move across, as a box fingering does. In open position an open
 * string is preferred over the 4th fret of the string below (the B on the
 * open B string, not the G string's 4th fret). Notes the box can't reach are
 * placed as close to it as possible and marked out of the box.
 */
export function layout(
  midis: readonly number[],
  box: Box,
  tuning = STANDARD_TUNING,
): Map<number, FretPosition> {
  const sorted = [...new Set(midis)].sort((a, b) => a - b);
  const out = new Map<number, FretPosition>();
  let current = 0;
  const fits = (s: number, midi: number, lo: number, hi: number) => {
    const fret = midi - tuning[s];
    return fret >= lo && fret <= hi ? fret : null;
  };
  for (const midi of sorted) {
    let placed: FretPosition | null = null;
    for (const [lo, hi] of [[box.lo, box.hi], [box.stretchLo, box.stretchHi]]) {
      for (let s = current; s < tuning.length && !placed; s++) {
        const fret = fits(s, midi, lo, hi);
        if (fret === null) continue;
        // Open position: prefer the next string's open note to a 4th fret.
        if (box.position === 0 && s + 1 < tuning.length && midi === tuning[s + 1]) {
          placed = { string: s + 1, fret: 0, inBox: true };
        } else {
          placed = { string: s, fret, inBox: true };
        }
      }
      if (placed) break;
    }
    if (!placed) {
      // Out of reach: the string where it sits nearest the box.
      let bestDist = Infinity;
      for (let s = 0; s < tuning.length; s++) {
        const fret = midi - tuning[s];
        if (fret < 0 || fret > MAX_FRET) continue;
        const dist = fret < box.lo ? box.lo - fret : Math.max(0, fret - box.hi);
        if (dist < bestDist || (dist === bestDist && s >= current)) {
          bestDist = dist;
          placed = { string: s, fret, inBox: false };
        }
      }
    }
    if (placed) {
      out.set(midi, placed);
      current = placed.string;
    }
  }
  return out;
}

/** Every place `midi` can be played, low string first. */
export function placesFor(midi: number, tuning = STANDARD_TUNING): FretPosition[] {
  const out: FretPosition[] = [];
  tuning.forEach((open, s) => {
    const fret = midi - open;
    if (fret >= 0 && fret <= MAX_FRET) out.push({ string: s, fret, inBox: false });
  });
  return out;
}

/** The lowest and highest notes a standard guitar plays (open E2 to 24th fret E6). */
export const GUITAR_RANGE = { lo: 40, hi: 88 } as const;
