// Which finger plays each note: conventional scale fingering on piano, one
// finger per fret on guitar. Pure, so the rules are pinned by tests against
// the fingerings teachers use.
//
// Piano scale fingering is a convention, but a regular one: the hand plays
// a group of fingers (1 2 3, or 1 2 3 4), then passes the thumb under to
// start the next group. So a fingering is a choice of which scale notes the
// thumb takes. Rather than store a table per key, the thumb notes are chosen
// by the rules a table would encode, in order of priority:
//
//  1. The thumb stays off black keys (unless the scale has no white keys).
//  2. As few thumb crossings as possible: groups of up to four fingers.
//  3. When the tonic is a white key, the thumb takes it.
//  4. The thumb crosses where it's easiest: right hand, onto a white key
//     just after a black one going up; left hand, from a white key just
//     before a black one (the mirror image).
//  5. Where the thumb has to land on a black key (a pentatonic with no
//     white keys to spare), it crosses at the scale's wide gaps.
//  6. At the end the hand reaches furthest: the top note of the right hand
//     and the bottom note of the left take 5 rather than 4 where possible.
//
// The fingering is a function of the scale note, the same in every octave,
// except at the outer ends, where there is no next group: the right hand's
// top note and the left hand's bottom note take the next finger along
// instead of the thumb, and the right hand starts a scale on 2 rather than 4
// when the thumb comes straight after (B♭ major: 2 1 2 3 1 2 3 4). These rules give the standard fingerings for every
// major and harmonic minor key in both hands (see fingering_test.ts), and
// carry over sensibly to the modes, pentatonic and blues scales.
//
// Chromatic scales have their own convention: 3 on black keys, 1 on white,
// and 2 where two white keys meet (F and C in the right hand, E and B in the
// left).

import type { Box, FretPosition } from "./guitar.ts";
import type { Hand, Step } from "./theory.ts";

/** Fingers for every note of every step, shaped like the steps; null shows none. */
export type Fingers = (number | null)[][];

const BLACK = new Set([1, 3, 6, 8, 10]);
const mod = (n: number, m: number) => ((n % m) + m) % m;
const isBlack = (midi: number) => BLACK.has(mod(midi, 12));

/** Finger for each scale degree of one octave, indexed like `form`. */
type Pattern = number[];

/**
 * The fingering for one octave of a scale. `form` is the scale's pitch
 * classes as semitones above the tonic, ascending from 0; `tonicPc` places
 * it on the keyboard.
 */
export function scalePattern(form: readonly number[], tonicPc: number, hand: Hand): Pattern {
  const n = form.length;
  const black = form.map((s) => isBlack(tonicPc + s));
  let best: { pattern: Pattern; score: number[] } | null = null;
  for (let mask = 1; mask < 1 << n; mask++) {
    const thumbs = form.map((_, d) => d).filter((d) => mask & (1 << d));
    // Gap from each thumb note to the next, around the octave.
    const gaps = thumbs.map((t, i) => mod(thumbs[(i + 1) % thumbs.length] - t - 1, n) + 1);
    if (gaps.some((g) => g < 2 || g > 4)) continue;
    const pattern = form.map((_, d) => {
      if (hand === "rh") {
        // Count up from the last thumb note at or below d.
        let k = 0;
        while (!(mask & (1 << mod(d - k, n)))) k++;
        return k + 1;
      }
      // Left hand going up counts down to the next thumb at or above d.
      let k = 0;
      while (!(mask & (1 << mod(d + k, n)))) k++;
      return k + 1;
    });
    // Forced onto black keys, the thumb crosses at the scale's wide gaps
    // (the minor thirds of a pentatonic), where the hand shifts anyway:
    // right hand onto the note above a gap, left hand from the note below.
    const gapBelow = (d: number) => mod(form[d] - form[mod(d - 1, n)], 12);
    const wideBlackCrossings = thumbs.filter((t) =>
      black[t] && (hand === "rh" ? gapBelow(t) : gapBelow(mod(t + 1, n))) >= 3
    ).length;
    const easyCrossings = thumbs.filter((t) =>
      hand === "rh" ? black[mod(t - 1, n)] : black[mod(t + 1, n)]
    ).length;
    const tonicThumb = mask & 1;
    const endFinger = !tonicThumb ? 0 : (hand === "rh" ? pattern[n - 1] : pattern[1]) + 1;
    const score = [
      thumbs.filter((t) => black[t]).length,
      thumbs.length,
      !black[0] && !tonicThumb ? 1 : 0,
      -easyCrossings,
      -wideBlackCrossings,
      -endFinger,
    ];
    if (!best || lexLess(score, best.score)) best = { pattern, score };
  }
  return best!.pattern;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Chromatic fingering for one note of a run. */
function chromaticFinger(midi: number, hand: Hand): number {
  if (isBlack(midi)) return 3;
  // Two white keys in a row: the right hand puts 2 on the upper (F, C),
  // the left hand on the lower (E, B).
  const pairedWhite = hand === "rh" ? !isBlack(midi - 1) : !isBlack(midi + 1);
  return pairedWhite ? 2 : 1;
}

/** Semitones above the tonic of a run's distinct pitch classes, ascending. */
function formOf(midis: number[], tonicPc: number): number[] {
  return [...new Set(midis.map((m) => mod(m - tonicPc, 12)))].sort((a, b) => a - b);
}

// ---- Arpeggios ----------------------------------------------------------------
//
// Root-position arpeggios follow a table, as teachers teach them: the
// fingering depends on the black/white shape of the triad, so it is
// grouped by key (Joy Morin, "Scale & Arpeggio Fingerings for Piano",
// colorinmypiano.com, which agrees with the common scale books).
// Each pattern gives the finger on the root, third and fifth in the
// middle of a run, and on the root at the bottom and top ends.

interface ArpPattern {
  root: number;
  third: number;
  fifth: number;
  bottom: number;
  top: number;
}
const ARP = {
  // RH 123 1235: C, G, F, D, A, E, B, G♭ major; most minors.
  rh123: { root: 1, third: 2, fifth: 3, bottom: 1, top: 5 },
  // RH 2 124 124: E♭, A♭, D♭, B♭ major; F♯, C♯, G♯ minor.
  rh124: { root: 4, third: 1, fifth: 2, bottom: 2, top: 4 },
  // RH 23 123 12: B♭ minor.
  rh23: { root: 2, third: 3, fifth: 1, bottom: 2, top: 2 },
  // LH 5421 421: C, G, F major; most minors.
  lh5421: { root: 1, third: 4, fifth: 2, bottom: 5, top: 1 },
  // LH 5321 321: D, A, E, B, G♭ major.
  lh5321: { root: 1, third: 3, fifth: 2, bottom: 5, top: 1 },
  // LH 21 421 42: the black-key-rooted triads with a white third.
  lh21: { root: 2, third: 1, fifth: 4, bottom: 2, top: 2 },
  // LH 321 321 2: B♭ minor.
  lh321: { root: 3, third: 2, fifth: 1, bottom: 3, top: 2 },
} satisfies Record<string, ArpPattern>;

/** The arpeggio pattern for a root (pitch class) and quality, per hand. */
function arpPattern(rootPc: number, minor: boolean, hand: Hand): ArpPattern {
  if (!minor) {
    if ([3, 8, 1, 10].includes(rootPc)) return hand === "rh" ? ARP.rh124 : ARP.lh21; // E♭ A♭ D♭ B♭
    if ([0, 7, 5].includes(rootPc)) return hand === "rh" ? ARP.rh123 : ARP.lh5421; // C G F
    return hand === "rh" ? ARP.rh123 : ARP.lh5321; // D A E B G♭
  }
  if ([6, 1, 8].includes(rootPc)) return hand === "rh" ? ARP.rh124 : ARP.lh21; // F♯ C♯ G♯
  if (rootPc === 10) return hand === "rh" ? ARP.rh23 : ARP.lh321; // B♭
  return hand === "rh" ? ARP.rh123 : ARP.lh5421;
}

function arpeggioFingers(line: { midi: number }[], hand: Hand, minor: boolean): number[] {
  const rootPc = mod(line[0].midi, 12);
  const p = arpPattern(rootPc, minor, hand);
  const lo = Math.min(...line.map((x) => x.midi));
  const hi = Math.max(...line.map((x) => x.midi));
  return line.map(({ midi }) => {
    const deg = mod(midi - rootPc, 12);
    if (deg === 0 && midi === lo) return p.bottom;
    if (deg === 0 && midi === hi) return p.top;
    return deg === 0 ? p.root : deg === 7 ? p.fifth : p.third;
  });
}

// ---- Block chords ----------------------------------------------------------------

/**
 * Triads in any inversion, as taught: the right hand plays 1-3-5, or
 * 1-2-5 when the top two notes are a fourth apart (first inversion); the
 * left hand plays 5-3-1, or 5-2-1 when the bottom two are a fourth apart
 * (second inversion).
 */
function triadFingers(midis: number[], hand: Hand): number[] {
  const sorted = [...midis].sort((a, b) => a - b);
  const [a, b, c] = sorted;
  const byPitch = hand === "rh" ? [1, c - b >= 5 ? 2 : 3, 5] : [5, b - a >= 5 ? 2 : 3, 1];
  return midis.map((m) => byPitch[sorted.indexOf(m)]);
}

function chordFingers(step: Step): (number | null)[] {
  const out: (number | null)[] = step.notes.map(() => null);
  for (const hand of ["rh", "lh"] as const) {
    const idx = step.notes.map((n, i) => (n.hand === hand ? i : -1)).filter((i) => i >= 0);
    if (idx.length !== 3) continue;
    triadFingers(idx.map((i) => step.notes[i].midi), hand).forEach((f, k) => (out[idx[k]] = f));
  }
  return out;
}

/** Fingers for one hand's line through the exercise. */
function handFingers(line: { midi: number; up: boolean }[], hand: Hand): number[] {
  const tonicPc = mod(line[0].midi, 12);
  const upForm = formOf(line.filter((x) => x.up).map((x) => x.midi), tonicPc);
  // A root-position triad arpeggio (major or minor) uses the table.
  if (upForm.join() === "0,4,7" || upForm.join() === "0,3,7") {
    return arpeggioFingers(line, hand, upForm[1] === 3);
  }
  const down = line.filter((x) => !x.up).map((x) => x.midi);
  const downForm = down.length ? formOf(down, tonicPc) : upForm;
  const lo = Math.min(...line.map((x) => x.midi));
  const hi = Math.max(...line.map((x) => x.midi));

  if (upForm.length === 12) {
    return line.map(({ midi }) => {
      const f = chromaticFinger(midi, hand);
      // The outer note starts or ends the run: the thumb, not 2.
      if (f === 2 && midi === (hand === "rh" ? lo : hi)) return 1;
      return f;
    });
  }

  const patterns = {
    up: scalePattern(upForm, tonicPc, hand),
    down: scalePattern(downForm, tonicPc, hand),
  };
  const fingers = line.map(({ midi, up }) => {
    const form = up ? upForm : downForm;
    return patterns[up ? "up" : "down"][form.indexOf(mod(midi - tonicPc, 12))];
  });
  // At the outer end there is no next group to pass the thumb into, so
  // that note takes the next finger along instead.
  const end = hand === "rh" ? hi : lo;
  line.forEach(({ midi }, i) => {
    if (midi !== end || fingers[i] !== 1) return;
    // Past the larger of its neighbours, so neither repeats its finger.
    const around = [fingers[i - 1], fingers[i + 1]].filter((f) => f !== undefined);
    if (around.length) fingers[i] = Math.min(5, Math.max(...around) + 1);
  });
  // The right hand never starts (or finishes) a scale on 4 with the thumb
  // next: B♭ major is taught 2 1 2 3 1 2 3 4, with 4 on the B♭s in between.
  if (hand === "rh") {
    line.forEach(({ midi }, i) => {
      if (midi === lo && fingers[i] === 4 && (fingers[i - 1] === 1 || fingers[i + 1] === 1)) {
        fingers[i] = 2;
      }
    });
  }
  return fingers;
}

/**
 * Piano fingering for every note of every step, shaped like the steps
 * (`result[step][note]`, notes in the step's order). Each hand is fingered
 * on its own, as in any scale book.
 */
export function pianoFingering(steps: readonly Step[]): Fingers {
  if (!steps.length) return [];
  if (steps[0].notes.length > 2 || steps[0].notes.filter((n) => n.hand === "rh").length > 1) {
    return steps.map(chordFingers);
  }
  const out: Fingers = steps.map((s) => s.notes.map(() => null));
  steps[0].notes.forEach((first, h) => {
    // The turning note at the top belongs to the way down: in melodic
    // minor the descent has other notes, and the hand sets up for them.
    const turn = steps.some((s) => s.direction === "down")
      ? steps.findLastIndex((s) => s.direction === "up")
      : -1;
    const line = steps.map((s, i) => ({
      midi: s.notes[h].midi,
      up: s.direction === "up" && i !== turn,
    }));
    handFingers(line, first.hand).forEach((f, i) => (out[i][h] = f));
  });
  return out;
}

/**
 * Guitar fingering in a position: one finger per fret, the index on the
 * box's first fret, a stretch taken by the index (below) or little finger
 * (above). 0 means an open string. A note outside the box has no finger:
 * the hand has to shift for it, and where to is the player's call.
 */
export function guitarFinger(p: FretPosition, box: Box): number | null {
  if (!p.inBox) return null;
  if (p.fret === 0) return 0;
  const first = Math.max(1, box.lo);
  return Math.min(4, Math.max(1, p.fret - first + 1));
}

/** Guitar fingering for every note of every step, from the box layout. */
export function guitarFingering(
  steps: readonly Step[],
  places: Map<number, FretPosition>,
  box: Box,
): Fingers {
  return steps.map((s) =>
    s.notes.map((n) => {
      const p = places.get(n.midi);
      return p ? guitarFinger(p, box) : null;
    })
  );
}
