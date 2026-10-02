// A piece of music as the grading engines see it: a time-ordered list of
// events (the notes that start together), a tempo map, and measures. Pure,
// and independent of the renderer: score_view.ts walks OpenSheetMusicDisplay's
// cursor and hands over plain RawEntry records, so all of this is tested
// without a browser.
//
// Practising a selection (one hand, a range of measures) turns events into
// the same Steps the scales use, so NotesEngine and TempoEngine grade songs
// unchanged. Notes left out (the other hand, tied continuations) become the
// accompaniment the page can play.

import type { Hand, Note, Spelled, Step } from "./theory.ts";

/** One note under the renderer's cursor, as plain data. */
export interface RawNote {
  midi: number;
  spelled: Spelled;
  /** 0 = top staff (right hand), 1+ = lower staves (left hand). */
  staff: number;
  /** "continue" = the held-over end of a tie: sounds, but is not played again. */
  tie: "none" | "start" | "continue";
  /** Sounding length in quarter notes, including any notes tied on. */
  quarters: number;
  finger?: string;
  /** The renderer's handle for marking this note (index into its list). */
  ref: number;
}

/** One cursor position: what starts at a moment in the piece. */
export interface RawEntry {
  /** Written measure number (as printed, from 1). */
  measure: number;
  /**
   * Counts measures as played, rising each time a measure starts, so a
   * measure repeated straight after itself is told apart from itself.
   */
  occurrence: number;
  /** Quarter notes from the start, with repeats played out. */
  beat: number;
  /** Quarter-note tempo in force here. */
  bpm: number;
  notes: RawNote[];
}

export interface ScoreNote extends RawNote {
  hand: Hand;
}

export interface ScoreEvent {
  index: number;
  measure: number;
  /** Which played measure this is (a repeated measure has two). */
  occurrence: number;
  beat: number;
  notes: ScoreNote[];
}

export interface TempoChange {
  beat: number;
  bpm: number;
}

export interface Score {
  events: ScoreEvent[];
  tempo: TempoChange[];
  /** Written measure numbers in playing order (a repeated measure appears twice). */
  measures: number[];
  /** The highest written measure number. */
  measureCount: number;
  /** True when the piece has more than one staff (two hands). */
  twoHands: boolean;
}

export const DEFAULT_BPM = 100;

/** A part (instrument) of the score, as far as choosing what to grade goes. */
export interface PartInfo {
  name: string;
  staves: number;
}

/** Which parts to grade, and the staff number their first staff counts as. */
export interface PartChoice {
  part: number;
  staffOffset: number;
}

const HAND_NAME = /\b(right|left|r\.?\s?h\.?|l\.?\s?h\.?|rechts|links|droite|gauche)\b/i;
const KEYBOARD_NAME = /piano|pno|klavier|keyboard|clavier|cembalo|harpsichord|organ/i;

/**
 * The part or parts the player plays. A piano is usually one part on two
 * staves; but some files write it as two parts ("Piano (right)", "Piano
 * (left)"), which are graded together as right and left hand. In a song
 * with voice and piano, the piano. Otherwise the first part.
 */
export function chooseParts(parts: readonly PartInfo[]): PartChoice[] {
  if (!parts.length) return [];
  const grand = parts.findIndex((p) => p.staves >= 2 && KEYBOARD_NAME.test(p.name));
  if (grand >= 0) return [{ part: grand, staffOffset: 0 }];
  const anyGrand = parts.findIndex((p) => p.staves >= 2);
  // Two one-staff parts named as hands, next to each other: one piano.
  for (let i = 0; i + 1 < parts.length; i++) {
    const [a, b] = [parts[i], parts[i + 1]];
    if (a.staves === 1 && b.staves === 1 && HAND_NAME.test(a.name) && HAND_NAME.test(b.name)) {
      return [{ part: i, staffOffset: 0 }, { part: i + 1, staffOffset: 1 }];
    }
  }
  return [{ part: anyGrand >= 0 ? anyGrand : 0, staffOffset: 0 }];
}

/** Build the score from the renderer's cursor walk. */
export function buildScore(entries: readonly RawEntry[]): Score {
  const twoHands = entries.some((e) => e.notes.some((n) => n.staff > 0));
  // Merge entries at the same moment (voices the cursor reports apart) and
  // drop rests-only positions.
  const byBeat = new Map<number, RawEntry>();
  for (const e of entries) {
    const key = Math.round(e.beat * 1e6) / 1e6;
    const prev = byBeat.get(key);
    if (prev) prev.notes.push(...e.notes);
    else byBeat.set(key, { ...e, beat: key, notes: [...e.notes] });
  }
  const sorted = [...byBeat.values()].sort((a, b) => a.beat - b.beat);

  const tempo: TempoChange[] = [];
  for (const e of sorted) {
    const bpm = e.bpm > 0 ? e.bpm : DEFAULT_BPM;
    if (!tempo.length || tempo.at(-1)!.bpm !== bpm) tempo.push({ beat: e.beat, bpm });
  }
  if (!tempo.length) tempo.push({ beat: 0, bpm: DEFAULT_BPM });
  tempo[0] = { ...tempo[0], beat: Math.min(0, tempo[0].beat) };

  const events: ScoreEvent[] = sorted
    .filter((e) => e.notes.length)
    .map((e, index) => ({
      index,
      measure: e.measure,
      occurrence: e.occurrence,
      beat: e.beat,
      notes: e.notes.map((n) => ({ ...n, hand: n.staff > 0 ? "lh" : "rh" })),
    }));

  const measures: number[] = [];
  let last = NaN;
  for (const e of sorted) {
    if (e.occurrence !== last) measures.push(e.measure);
    last = e.occurrence;
  }
  return {
    events,
    tempo,
    measures,
    measureCount: Math.max(0, ...sorted.map((e) => e.measure)),
    twoHands,
  };
}

/** Milliseconds from the start of the piece to `beat`, at `pct` % of the marked tempo. */
export function msAt(tempo: readonly TempoChange[], beat: number, pct = 100): number {
  // Sum each tempo segment's share of [0, beat].
  let ms = 0;
  tempo.forEach((t, i) => {
    const a = Math.max(0, t.beat);
    const b = Math.min(beat, tempo[i + 1]?.beat ?? Infinity);
    if (b > a) ms += ((b - a) * 60000) / t.bpm;
  });
  return (ms * 100) / pct;
}

/** The marked tempo at `beat`. */
export function bpmAt(tempo: readonly TempoChange[], beat: number): number {
  let bpm = tempo[0]?.bpm ?? DEFAULT_BPM;
  for (const t of tempo) if (t.beat <= beat) bpm = t.bpm;
  return bpm;
}

export interface Selection {
  hands: "both" | "rh" | "lh";
  /** Written measure range, inclusive. Omitted = the whole piece. */
  from?: number;
  to?: number;
}

/** A note the page plays for the player (the other hand, in tempo or listen mode). */
export interface AccompanimentNote {
  beat: number;
  midi: number;
  quarters: number;
}

export interface Practice {
  steps: Step[];
  /** Beat of each step. */
  beats: number[];
  /** The score event behind each step. */
  events: ScoreEvent[];
  /** Notes of the selection that are not graded: the other hand. */
  accompaniment: AccompanimentNote[];
  /** Every note of the selection, for listen mode. */
  all: AccompanimentNote[];
  /** Beat where the selection starts (its first measure's first event). */
  startBeat: number;
}

/**
 * The steps to grade for a selection. A step is the notes of one event
 * that the chosen hand(s) strike: tied continuations are held, not played,
 * so they are not graded; a pitch both hands share is graded once. Events
 * with nothing to play are skipped; their notes are accompaniment.
 */
export function practiceSteps(score: Score, sel: Selection): Practice {
  const from = sel.from ?? 1;
  const to = sel.to ?? score.measureCount;
  const inRange = score.events.filter((e) => e.measure >= from && e.measure <= to);
  const plays = (n: ScoreNote) => sel.hands === "both" || n.hand === sel.hands;

  const steps: Step[] = [];
  const beats: number[] = [];
  const events: ScoreEvent[] = [];
  const accompaniment: AccompanimentNote[] = [];
  const all: AccompanimentNote[] = [];
  for (const e of inRange) {
    const notes: Note[] = [];
    for (const n of e.notes) {
      if (n.tie === "continue") continue;
      all.push({ beat: e.beat, midi: n.midi, quarters: n.quarters });
      if (!plays(n)) {
        accompaniment.push({ beat: e.beat, midi: n.midi, quarters: n.quarters });
        continue;
      }
      if (!notes.some((x) => x.midi === n.midi)) {
        notes.push({ midi: n.midi, spelled: n.spelled, hand: n.hand });
      }
    }
    if (!notes.length) continue;
    // Right hand first, then left, each low to high: the order the scales use.
    notes.sort((a, b) => (a.hand === b.hand ? a.midi - b.midi : a.hand === "rh" ? -1 : 1));
    steps.push({ index: steps.length, notes, direction: "up" });
    beats.push(e.beat);
    events.push(e);
  }
  return { steps, beats, events, accompaniment, all, startBeat: inRange[0]?.beat ?? 0 };
}

/** Each step's due time in ms after the selection starts, at `pct` % tempo. */
export function stepOffsets(score: Score, p: Practice, pct = 100): number[] {
  const t0 = msAt(score.tempo, p.startBeat, pct);
  return p.beats.map((b) => msAt(score.tempo, b, pct) - t0);
}

export interface MeasureStat {
  measure: number;
  steps: number;
  clean: number;
  wrong: number;
  missed: number;
  early: number;
  late: number;
}

/**
 * How each written measure went, for the heat map. `results` are the
 * engine's StepResults, parallel to p.steps. A measure played twice (a
 * repeat) adds both passes together.
 */
export function measureStats(
  p: Practice,
  results: readonly {
    status: string;
    clean: boolean;
    wrong: readonly number[];
    grade: string | null;
  }[],
): MeasureStat[] {
  const by = new Map<number, MeasureStat>();
  p.events.forEach((e, i) => {
    const r = results[i];
    if (!r) return;
    const m = by.get(e.measure) ??
      { measure: e.measure, steps: 0, clean: 0, wrong: 0, missed: 0, early: 0, late: 0 };
    m.steps++;
    if (r.status === "ok" && r.clean) m.clean++;
    if (r.status === "missed") m.missed++;
    m.wrong += r.wrong.length;
    if (r.grade === "early") m.early++;
    if (r.grade === "late") m.late++;
    by.set(e.measure, m);
  });
  return [...by.values()].sort((a, b) => a.measure - b.measure);
}

/**
 * The weakest stretch to loop: the run of up to `span` consecutive measures
 * with the lowest clean ratio (ties go to the earlier). Null when every
 * measure was clean.
 */
export function weakestRange(
  stats: readonly MeasureStat[],
  span = 2,
): { from: number; to: number } | null {
  if (!stats.length || stats.every((m) => m.clean === m.steps)) return null;
  let best: { from: number; to: number; score: number } | null = null;
  for (let i = 0; i < stats.length; i++) {
    const run = stats.slice(i, i + span);
    const steps = run.reduce((a, m) => a + m.steps, 0);
    const clean = run.reduce((a, m) => a + m.clean, 0);
    const score = steps ? clean / steps : 1;
    if (!best || score < best.score) {
      best = { from: run[0].measure, to: run.at(-1)!.measure, score };
    }
  }
  return best && { from: best.from, to: best.to };
}

// ---- Moving through a selection ------------------------------------------
//
// The play position is a step index within the selection. Measures are
// counted as played, so with repeats the same written measure is two stops.

/** Step indices where each played measure of the selection begins. */
export function measureStarts(p: Practice): number[] {
  const out: number[] = [];
  p.events.forEach((e, i) => {
    if (i === 0 || e.occurrence !== p.events[i - 1].occurrence) out.push(i);
  });
  return out;
}

/**
 * The step to move to from step i, one measure back (-1) or forward (+1).
 * Back from inside a measure goes to its start first, as a media player's
 * "previous" goes to the start of the track; at either end it stays.
 */
export function stepFromMeasure(p: Practice, i: number, dir: -1 | 1): number {
  const starts = measureStarts(p);
  if (!starts.length) return 0;
  let cur = 0;
  while (cur + 1 < starts.length && starts[cur + 1] <= i) cur++;
  if (dir < 0) return i > starts[cur] ? starts[cur] : starts[Math.max(0, cur - 1)];
  return starts[Math.min(starts.length - 1, cur + 1)];
}

/** The step holding the note `ref` (the renderer's handle), or the next one after it. */
export function stepOfRef(p: Practice, ref: number): number {
  const at = p.events.findIndex((e) => e.notes.some((n) => n.ref === ref));
  if (at >= 0) return at;
  // A ref not graded here (the other hand, a tied note): the step at its beat.
  const all = p.events.flatMap((e) => e.notes.map((n) => ({ ref: n.ref, beat: e.beat })));
  const beat = all.find((x) => x.ref === ref)?.beat;
  if (beat === undefined) return 0;
  const next = p.beats.findIndex((b) => b >= beat - 1e-9);
  return next >= 0 ? next : p.steps.length - 1;
}

/**
 * The selection from step k on, as its own Practice: steps renumbered from
 * 0, timed from step k, with the accompaniment and listen notes from there.
 * A run that starts mid-selection (a seek, a resume) plays one of these.
 */
export function sliceFrom(p: Practice, k: number): Practice {
  const start = Math.min(Math.max(0, k), Math.max(0, p.steps.length - 1));
  const startBeat = p.beats[start] ?? p.startBeat;
  return {
    steps: p.steps.slice(start).map((s, i) => ({ ...s, index: i })),
    beats: p.beats.slice(start),
    events: p.events.slice(start),
    accompaniment: p.accompaniment.filter((n) => n.beat >= startBeat - 1e-9),
    all: p.all.filter((n) => n.beat >= startBeat - 1e-9),
    startBeat,
  };
}
