// The music model: spelled notes, scale definitions, and the step sequence a
// practice run walks through. Pure — no DOM — so it is unit-tested directly.
//
// Notes are *spelled* (letter + accidental), not just MIDI numbers, because
// the staff has to show F♯ major's E♯ as E♯ rather than F, and harmonic minor
// in G♯ needs an F𝄪. The grading only ever compares MIDI numbers, since
// that is all an instrument reports.

export type Letter = "C" | "D" | "E" | "F" | "G" | "A" | "B";
export const LETTERS: readonly Letter[] = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC: Record<Letter, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};
// Position on the circle of fifths of each natural letter, relative to C.
const LETTER_FIFTHS: Record<Letter, number> = {
  F: -1,
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
};

/** A pitch name without octave: letter plus accidental (-2 = 𝄫 … +2 = 𝄪). */
export interface PitchName {
  letter: Letter;
  acc: number;
}

/** A fully spelled note: pitch name plus scientific octave (C4 = middle C). */
export interface Spelled extends PitchName {
  octave: number;
}

export type Hand = "rh" | "lh";

export interface Note {
  midi: number;
  spelled: Spelled;
  hand: Hand;
}

export interface Step {
  index: number;
  /**
   * The notes to play together, right hand's first. One per hand for scales
   * and arpeggios; a triad per hand for chord exercises.
   */
  notes: Note[];
  direction: "up" | "down";
}

export type ScaleType =
  | "major"
  | "natural-minor"
  | "harmonic-minor"
  | "melodic-minor"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "locrian"
  | "major-pentatonic"
  | "minor-pentatonic"
  | "blues"
  | "chromatic"
  | "major-arpeggio"
  | "minor-arpeggio"
  | "major-inversions"
  | "minor-inversions";

interface ScaleDef {
  label: string;
  /** Semitones above the tonic, ascending. */
  up: number[];
  /** Letter steps above the tonic's letter, parallel to `up`. */
  letters: number[];
  /** A different descending form (melodic minor), as ascending intervals. */
  down?: number[];
  downLetters?: number[];
  /**
   * The relative major: how far (semitones, letters) from this tonic to the
   * tonic of the major key sharing its key signature. Drives both the key
   * signature and which enharmonic tonic spelling is the sensible default.
   * Absent for scales drawn without a key signature.
   */
  relMajor?: [semitones: number, letters: number];
  /**
   * Which ring of the circle-of-fifths picker the scale belongs to: major
   * (major third) or minor (minor third). Chromatic has no third and sits
   * under both.
   */
  family: Family | "both";
  /**
   * Block chords rather than single notes: the triad on `up`/`letters`
   * through its inversions (root, first, second, root an octave up…).
   * Guitar can't be graded on these: its pitch tracker hears one note.
   */
  chord?: boolean;
}

export type Family = "major" | "minor";

const HEPT = [0, 1, 2, 3, 4, 5, 6];

export const SCALES: Record<ScaleType, ScaleDef> = {
  "major": {
    label: "Major (Ionian)",
    family: "major",
    up: [0, 2, 4, 5, 7, 9, 11],
    letters: HEPT,
    relMajor: [0, 0],
  },
  "natural-minor": {
    label: "Natural minor (Aeolian)",
    family: "minor",
    up: [0, 2, 3, 5, 7, 8, 10],
    letters: HEPT,
    relMajor: [3, 2],
  },
  "harmonic-minor": {
    label: "Harmonic minor",
    family: "minor",
    up: [0, 2, 3, 5, 7, 8, 11],
    letters: HEPT,
    relMajor: [3, 2],
  },
  "melodic-minor": {
    label: "Melodic minor",
    family: "minor",
    up: [0, 2, 3, 5, 7, 9, 11],
    letters: HEPT,
    // Classical melodic minor: raised 6th and 7th going up, natural minor
    // coming down.
    down: [0, 2, 3, 5, 7, 8, 10],
    downLetters: HEPT,
    relMajor: [3, 2],
  },
  "dorian": {
    label: "Dorian",
    family: "minor",
    up: [0, 2, 3, 5, 7, 9, 10],
    letters: HEPT,
    relMajor: [-2, -1],
  },
  "phrygian": {
    label: "Phrygian",
    family: "minor",
    up: [0, 1, 3, 5, 7, 8, 10],
    letters: HEPT,
    relMajor: [-4, -2],
  },
  "lydian": {
    label: "Lydian",
    family: "major",
    up: [0, 2, 4, 6, 7, 9, 11],
    letters: HEPT,
    relMajor: [-5, -3],
  },
  "mixolydian": {
    label: "Mixolydian",
    family: "major",
    up: [0, 2, 4, 5, 7, 9, 10],
    letters: HEPT,
    relMajor: [5, 3],
  },
  "locrian": {
    label: "Locrian",
    family: "minor",
    up: [0, 1, 3, 5, 6, 8, 10],
    letters: HEPT,
    relMajor: [1, 1],
  },
  "major-pentatonic": {
    label: "Major pentatonic",
    family: "major",
    up: [0, 2, 4, 7, 9],
    letters: [0, 1, 2, 4, 5],
    relMajor: [0, 0],
  },
  "minor-pentatonic": {
    label: "Minor pentatonic",
    family: "minor",
    up: [0, 3, 5, 7, 10],
    letters: [0, 2, 3, 4, 6],
    relMajor: [3, 2],
  },
  "blues": {
    // The blue note is spelled as a flattened 5th (C E♭ F G♭ G B♭).
    label: "Blues",
    family: "minor",
    up: [0, 3, 5, 6, 7, 10],
    letters: [0, 2, 3, 4, 4, 6],
  },
  "chromatic": {
    // Spelled by convention rather than by letters: sharps going up, flats
    // coming down. See spellChromatic.
    label: "Chromatic",
    family: "both",
    up: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    letters: [],
  },
  // Arpeggios are scales of three notes, so they run through the same code.
  "major-arpeggio": {
    label: "Major arpeggio",
    family: "major",
    up: [0, 4, 7],
    letters: [0, 2, 4],
    relMajor: [0, 0],
  },
  "minor-arpeggio": {
    label: "Minor arpeggio",
    family: "minor",
    up: [0, 3, 7],
    letters: [0, 2, 4],
    relMajor: [3, 2],
  },
  "major-inversions": {
    label: "Major triad inversions",
    family: "major",
    up: [0, 4, 7],
    letters: [0, 2, 4],
    relMajor: [0, 0],
    chord: true,
  },
  "minor-inversions": {
    label: "Minor triad inversions",
    family: "minor",
    up: [0, 3, 7],
    letters: [0, 2, 4],
    relMajor: [3, 2],
    chord: true,
  },
};

export const SCALE_TYPES = Object.keys(SCALES) as ScaleType[];

const mod = (n: number, m: number) => ((n % m) + m) % m;

export function pitchClass(p: PitchName): number {
  return mod(LETTER_PC[p.letter] + p.acc, 12);
}

export function letterAt(letter: Letter, steps: number): Letter {
  return LETTERS[mod(LETTERS.indexOf(letter) + steps, 7)];
}

/** Spell `midi` on `letter`, deriving the accidental and octave. */
export function spell(midi: number, letter: Letter): Spelled {
  // The accidental is the smallest signed distance from the natural letter
  // to the pitch — within ±2 for anything a scale can produce.
  let acc = mod(midi - LETTER_PC[letter], 12);
  if (acc > 6) acc -= 12;
  // The octave belongs to the letter, not the sounding pitch: B♯3 sounds as
  // C4 and C♭4 sounds as B3.
  const octave = Math.floor((midi - acc) / 12) - 1;
  return { letter, acc, octave };
}

export function midiOf(s: Spelled): number {
  return (s.octave + 1) * 12 + LETTER_PC[s.letter] + s.acc;
}

const ACC_TEXT: Record<number, string> = {
  [-2]: "𝄫",
  [-1]: "♭",
  0: "",
  1: "♯",
  2: "𝄪",
};

export function nameOf(p: PitchName): string {
  return p.letter + ACC_TEXT[p.acc];
}

export function noteLabel(s: Spelled): string {
  return nameOf(s) + s.octave;
}

/**
 * Circle-of-fifths position of the key signature a scale on `tonic` is
 * written with (positive = sharps), or null for scales written with plain
 * accidentals (blues, chromatic).
 */
export function keySignatureFifths(
  tonic: PitchName,
  type: ScaleType,
): number | null {
  const rel = SCALES[type].relMajor;
  if (!rel) return null;
  const letter = letterAt(tonic.letter, rel[1]);
  const pc = pitchClass(tonic) + rel[0];
  let acc = mod(pc - LETTER_PC[letter], 12);
  if (acc > 6) acc -= 12;
  return LETTER_FIFTHS[letter] + 7 * acc;
}

export interface TonicOption {
  pc: number;
  /** Sensible spellings, the default first. Two when both are in use. */
  spellings: PitchName[];
}

/**
 * The twelve tonics for a scale type, each with its usable spellings.
 *
 * A spelling is usable when its key signature has at most 7 accidentals, so
 * A♯ major (10 sharps) is never offered but C♯ major (7) is, as the
 * alternative to D♭ (5 flats). The default is the spelling with the smaller
 * key signature; on a tie (F♯/G♭ major, D♯/E♭ minor) the flat spelling
 * leads. Scales without a key signature are spelled as the major would be.
 */
export function tonicOptions(type: ScaleType): TonicOption[] {
  const sigType: ScaleType = SCALES[type].relMajor
    ? type
    : type === "blues"
    ? "natural-minor"
    : "major";
  const out: TonicOption[] = [];
  for (let pc = 0; pc < 12; pc++) {
    const candidates: { p: PitchName; f: number }[] = [];
    for (const letter of LETTERS) {
      let acc = mod(pc - LETTER_PC[letter], 12);
      if (acc > 6) acc -= 12;
      if (Math.abs(acc) > 1) continue;
      const p = { letter, acc };
      const f = keySignatureFifths(p, sigType)!;
      if (Math.abs(f) <= 7) candidates.push({ p, f });
    }
    candidates.sort((a, b) => Math.abs(a.f) - Math.abs(b.f) || a.p.acc - b.p.acc);
    out.push({ pc, spellings: candidates.map((c) => c.p) });
  }
  return out;
}

// ---- The circle of fifths -------------------------------------------------
//
// The key picker is a circle of fifths: major keys on the outer ring, their
// relative minors on the inner ring. Wedge 0 is at the top (C major, A minor)
// and each step clockwise is a fifth up, one more sharp (or one fewer flat).

/**
 * The scales offered for each ring, in the order the picker lists them: the
 * ring's own default first, then the others roughly bright to dark (the
 * modes' own circle-of-fifths order), pentatonic and blues after the
 * seven-note scales, chromatic last because it has no third.
 */
export const VARIANTS: Record<Family, ScaleType[]> = {
  major: [
    "major",
    "lydian",
    "mixolydian",
    "major-pentatonic",
    "chromatic",
    "major-arpeggio",
    "major-inversions",
  ],
  minor: [
    "natural-minor",
    "harmonic-minor",
    "melodic-minor",
    "dorian",
    "phrygian",
    "locrian",
    "minor-pentatonic",
    "blues",
    "chromatic",
    "minor-arpeggio",
    "minor-inversions",
  ],
};

/** Whether `type` is offered on the `family` ring. */
export function inFamily(type: ScaleType, family: Family): boolean {
  const f = SCALES[type].family;
  return f === "both" || f === family;
}

/** The ring a scale type is shown on; chromatic defaults to the major ring. */
export function familyOf(type: ScaleType): Family {
  const f = SCALES[type].family;
  return f === "both" ? "major" : f;
}

export interface Wedge {
  /** 0 at the top, increasing clockwise. */
  index: number;
  /** Outer-ring spellings, the default first; two on the enharmonic wedges. */
  major: PitchName[];
  /** Inner-ring (relative minor) spellings. */
  minor: PitchName[];
}

/**
 * The twelve wedges. Spellings come from tonicOptions, so the enharmonic
 * pairs (F♯/G♭, D♭/C♯, B/C♭, E♭m/D♯m, G♯m/A♭m, B♭m/A♯m) and the rule that a
 * key signature has at most seven accidentals are the ones the rest of the
 * app already uses.
 */
export function circleOfFifths(): Wedge[] {
  const major = tonicOptions("major");
  const minor = tonicOptions("natural-minor");
  return Array.from({ length: 12 }, (_, k) => ({
    index: k,
    major: major[mod(7 * k, 12)].spellings,
    minor: minor[mod(7 * k + 9, 12)].spellings,
  }));
}

/** The wedge a tonic sits on, for the given ring. */
export function wedgeOf(tonic: PitchName, family: Family): number {
  // 7 is its own inverse mod 12, so "which k has 7k ≡ pc" is k = 7·pc.
  const pc = pitchClass(tonic);
  return mod(7 * (family === "major" ? pc : pc - 9), 12);
}

/**
 * The spelling to use for `pitch` as a `type` scale: the one given if its key
 * signature fits in seven accidentals, otherwise that pitch class's default.
 * So C♭ tapped on the major ring stays C♭ as a major scale but becomes B as
 * Mixolydian, whose C♭ form would need eight flats.
 */
export function resolveTonic(pitch: PitchName, type: ScaleType): PitchName {
  const { spellings } = tonicOptions(type)[pitchClass(pitch)];
  return spellings.find((s) => s.letter === pitch.letter && s.acc === pitch.acc) ??
    spellings[0];
}

export interface Neighbour {
  ring: Family;
  index: number;
  numeral: string;
}

/**
 * The selected key and its diatonic neighbours, with Roman numerals: the
 * keys either side on its own ring (IV and V, or iv and v) and the three on
 * the other ring (ii, iii, vi for a major key; III, VI, VII for a minor one).
 */
export function neighbourhood(index: number, family: Family): Neighbour[] {
  const [own, other] = family === "major"
    ? [["IV", "I", "V"], ["ii", "vi", "iii"]]
    : [["iv", "i", "v"], ["VI", "III", "VII"]];
  const otherRing: Family = family === "major" ? "minor" : "major";
  return [-1, 0, 1].flatMap((d, i) => [
    { ring: family, index: mod(index + d, 12), numeral: own[i] },
    { ring: otherRing, index: mod(index + d, 12), numeral: other[i] },
  ]);
}

/** "2♯", "3♭" or "" — the short key-signature label on a wedge. */
export function signatureShort(fifths: number): string {
  return fifths === 0 ? "" : `${Math.abs(fifths)}${fifths > 0 ? "♯" : "♭"}`;
}

/** "1 sharp", "3 flats", "no sharps or flats". */
export function signatureLong(fifths: number): string {
  if (fifths === 0) return "no sharps or flats";
  const n = Math.abs(fifths);
  return `${n} ${fifths > 0 ? "sharp" : "flat"}${n === 1 ? "" : "s"}`;
}

/**
 * Orders scales around the circle: by the key signature's position, so a
 * major key and its relative minor sit together; within a position, major
 * before minor, then the picker's variant order. Scales without a key
 * signature (blues, chromatic) come last, ordered by their tonic's wedge.
 */
export function compareByCircle(
  a: { tonic: PitchName; type: ScaleType },
  b: { tonic: PitchName; type: ScaleType },
): number {
  const fa = keySignatureFifths(a.tonic, a.type);
  const fb = keySignatureFifths(b.tonic, b.type);
  if ((fa === null) !== (fb === null)) return fa === null ? 1 : -1;
  const pos = (f: number | null, s: { tonic: PitchName; type: ScaleType }) =>
    f === null ? wedgeOf(s.tonic, familyOf(s.type)) : mod(f, 12);
  const rank = (s: { type: ScaleType }) => {
    const fam = familyOf(s.type);
    return (fam === "major" ? 0 : 100) + VARIANTS[fam].indexOf(s.type);
  };
  return pos(fa, a) - pos(fb, b) || rank(a) - rank(b) || (fa ?? 0) - (fb ?? 0) ||
    pitchClass(a.tonic) - pitchClass(b.tonic);
}

export interface ExerciseOptions {
  tonic: PitchName;
  type: ScaleType;
  octaves: number;
  direction: "up" | "updown";
  hands: "rh" | "lh" | "both";
  /**
   * The tonic's MIDI note, overriding the piano's startOctave. Guitar uses
   * it to start the scale where the chosen fretboard position puts it.
   * Only meaningful for a single hand.
   */
  tonicMidi?: number;
}

/**
 * The octave the right hand's tonic sits in. Longer scales start lower so
 * the top stays readable; the left hand plays an octave below the right.
 */
export function startOctave(
  o: Pick<ExerciseOptions, "octaves">,
  hand: Hand,
): number {
  const rh = o.octaves <= 2 ? 4 : 3;
  return hand === "rh" ? rh : rh - 1;
}

/** The scale as ascending spelled notes from tonicMidi, ending on the top tonic. */
function run(
  tonic: PitchName,
  tonicMidi: number,
  semis: number[],
  letters: number[],
  octaves: number,
): Spelled[] {
  const out: Spelled[] = [];
  for (let o = 0; o < octaves; o++) {
    semis.forEach((s, i) => {
      out.push(
        spell(tonicMidi + 12 * o + s, letterAt(tonic.letter, letters[i])),
      );
    });
  }
  out.push(spell(tonicMidi + 12 * octaves, tonic.letter));
  return out;
}

// Pitch-class spellings for the chromatic scale.
const SHARP_NAMES: PitchName[] = [
  { letter: "C", acc: 0 },
  { letter: "C", acc: 1 },
  { letter: "D", acc: 0 },
  { letter: "D", acc: 1 },
  { letter: "E", acc: 0 },
  { letter: "F", acc: 0 },
  { letter: "F", acc: 1 },
  { letter: "G", acc: 0 },
  { letter: "G", acc: 1 },
  { letter: "A", acc: 0 },
  { letter: "A", acc: 1 },
  { letter: "B", acc: 0 },
];
const FLAT_NAMES: PitchName[] = [
  { letter: "C", acc: 0 },
  { letter: "D", acc: -1 },
  { letter: "D", acc: 0 },
  { letter: "E", acc: -1 },
  { letter: "E", acc: 0 },
  { letter: "F", acc: 0 },
  { letter: "G", acc: -1 },
  { letter: "G", acc: 0 },
  { letter: "A", acc: -1 },
  { letter: "A", acc: 0 },
  { letter: "B", acc: -1 },
  { letter: "B", acc: 0 },
];

/**
 * Chromatic spelling: sharps ascending, flats descending, except that the
 * tonic's own pitch class always keeps the tonic's spelling.
 */
function spellChromatic(
  midi: number,
  tonic: PitchName,
  descending: boolean,
): Spelled {
  const pc = mod(midi, 12);
  const name = pc === pitchClass(tonic) ? tonic : (descending ? FLAT_NAMES : SHARP_NAMES)[pc];
  return spell(midi, name.letter);
}

/** The ascending (and, for melodic minor, descending) pitches of one hand. */
function handLine(
  o: ExerciseOptions,
  tonicMidi: number,
): { up: Spelled[]; down: Spelled[] } {
  const def = SCALES[o.type];
  if (o.type === "chromatic") {
    const up: Spelled[] = [];
    const down: Spelled[] = [];
    const n = 12 * o.octaves;
    for (let i = 0; i <= n; i++) {
      up.push(spellChromatic(tonicMidi + i, o.tonic, false));
      down.push(spellChromatic(tonicMidi + n - i, o.tonic, true));
    }
    return { up, down };
  }
  const up = run(o.tonic, tonicMidi, def.up, def.letters, o.octaves);
  const downSource = def.down ? run(o.tonic, tonicMidi, def.down, def.downLetters!, o.octaves) : up;
  return { up, down: [...downSource].reverse() };
}

/**
 * One hand's block chords for an inversions exercise: chord k stacks the
 * triad's tones k, k+1 and k+2, so k = 0, 1, 2 are root position, first
 * and second inversion, and k = 3 is root position an octave up.
 */
function chordLine(o: ExerciseOptions, tonicMidi: number): Spelled[][] {
  const def = SCALES[o.type];
  const tone = (j: number): Spelled =>
    spell(
      tonicMidi + def.up[j % 3] + 12 * Math.floor(j / 3),
      letterAt(o.tonic.letter, def.letters[j % 3]),
    );
  const up = Array.from(
    { length: 3 * o.octaves + 1 },
    (_, k) => [tone(k), tone(k + 1), tone(k + 2)],
  );
  return o.direction === "updown" ? [...up, ...up.slice(0, -1).reverse()] : up;
}

function chordSteps(o: ExerciseOptions, hands: Hand[]): Step[] {
  const lines = hands.map((hand) => {
    const tonicMidi = o.tonicMidi ?? midiOf({ ...o.tonic, octave: startOctave(o, hand) });
    return { hand, chords: chordLine(o, tonicMidi) };
  });
  const top = 3 * o.octaves;
  return lines[0].chords.map((_, i) => ({
    index: i,
    direction: i <= top ? "up" : "down",
    notes: lines.flatMap((l) =>
      l.chords[i].map((spelled) => ({ midi: midiOf(spelled), spelled, hand: l.hand }))
    ),
  }));
}

/**
 * The exercise as steps. Ascending ends on the top tonic; up-and-down turns
 * there without repeating it and ends back on the starting tonic.
 */
export function buildSteps(o: ExerciseOptions): Step[] {
  if (o.octaves < 1 || o.octaves > 4 || !Number.isInteger(o.octaves)) {
    throw new RangeError(`octaves must be 1–4, got ${o.octaves}`);
  }
  const hands: Hand[] = o.hands === "both" ? ["rh", "lh"] : [o.hands];
  if (SCALES[o.type].chord) return chordSteps(o, hands);
  const lines = hands.map((hand) => {
    const tonicMidi = o.tonicMidi ?? midiOf({ ...o.tonic, octave: startOctave(o, hand) });
    return { hand, ...handLine(o, tonicMidi) };
  });

  const steps: Step[] = [];
  const len = lines[0].up.length;
  for (let i = 0; i < len; i++) {
    steps.push({
      index: steps.length,
      direction: "up",
      notes: lines.map((l) => ({
        midi: midiOf(l.up[i]),
        spelled: l.up[i],
        hand: l.hand,
      })),
    });
  }
  if (o.direction === "updown") {
    for (let i = 1; i < len; i++) {
      steps.push({
        index: steps.length,
        direction: "down",
        notes: lines.map((l) => ({
          midi: midiOf(l.down[i]),
          spelled: l.down[i],
          hand: l.hand,
        })),
      });
    }
  }
  return steps;
}

/** Human title, e.g. "D harmonic minor". */
export function scaleTitle(tonic: PitchName, type: ScaleType): string {
  const label = SCALES[type].label.replace(/ \(.*\)$/, "");
  return `${nameOf(tonic)} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}
