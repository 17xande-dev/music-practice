// The learning log: time spent learning a scale or song in Learn mode,
// kept apart from the graded history so first, stumbling attempts never
// drag down accuracy trends or personal bests. Stored beside the other
// records under its own key, and validated the same way: anything read
// back is checked field by field and rebuilt.

import type { Instrument } from "./progress_store.ts";
import type { SongMeasure } from "./song_session.ts";
import { MAX_MEASURES } from "./song_session.ts";

export const LEARN_KEY = "mp.v1.learn";
/** A gap between notes longer than this counts as this much: you walked away. */
export const IDLE_CAP_MS = 30_000;
/** Learn sessions per subject looked at for "where you stumble". */
export const RECENT_STUMBLES = 10;

export interface LearnSession {
  id: string;
  /** Epoch milliseconds when the pass ended (or was left). */
  ts: number;
  kind: "scale" | "song";
  /** scaleKey for a scale, the song's library id for a song. */
  subject: string;
  /** Readable name when learned, so the log still reads if a song is deleted. */
  title: string;
  /** Scales only; absent means piano. */
  instrument?: Instrument;
  hands: "both" | "rh" | "lh";
  /** Active time: gaps between notes are capped at IDLE_CAP_MS. */
  durationMs: number;
  /** Steps played through, and of how many. */
  steps: number;
  total: number;
  wrongNotes: number;
  /** Played to the end, rather than restarted or left part way. */
  complete: boolean;
  /** Songs: per-measure steps and clean steps, for where you stumble. */
  measures?: SongMeasure[];
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isCount = (x: unknown): x is number => isNum(x) && x >= 0 && Number.isInteger(x);
const isStr = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= max;

function validMeasure(x: unknown): x is SongMeasure {
  return isObj(x) && isCount(x.measure) && isCount(x.steps) && isCount(x.clean) &&
    x.clean <= x.steps;
}

export function validLearnSession(x: unknown): x is LearnSession {
  return isObj(x) &&
    isStr(x.id, 64) && isNum(x.ts) && x.ts > 0 &&
    (x.kind === "scale" || x.kind === "song") &&
    isStr(x.subject, 64) && isStr(x.title, 300) &&
    (x.instrument === undefined || x.instrument === "piano" || x.instrument === "guitar") &&
    ["both", "rh", "lh"].includes(x.hands as string) &&
    isNum(x.durationMs) && x.durationMs >= 0 &&
    isCount(x.steps) && isCount(x.total) && x.total > 0 && x.steps <= x.total &&
    isCount(x.wrongNotes) && typeof x.complete === "boolean" &&
    (x.measures === undefined ||
      (Array.isArray(x.measures) && x.measures.length <= MAX_MEASURES &&
        x.measures.every(validMeasure)));
}

/** Rebuilt from known fields only. */
export function cleanLearnSession(s: LearnSession): LearnSession {
  return {
    id: s.id,
    ts: s.ts,
    kind: s.kind,
    subject: s.subject,
    title: s.title,
    ...(s.instrument ? { instrument: s.instrument } : {}),
    hands: s.hands,
    durationMs: s.durationMs,
    steps: s.steps,
    total: s.total,
    wrongNotes: s.wrongNotes,
    complete: s.complete,
    ...(s.measures
      ? {
        measures: s.measures.map((m) => ({ measure: m.measure, steps: m.steps, clean: m.clean })),
      }
      : {}),
  };
}

/**
 * Active time across a pass: the time between the first and last note,
 * with each gap capped so a pause to read the music counts but a walk to
 * the kitchen doesn't.
 */
export class LearnClock {
  private last: number | null = null;
  private total = 0;

  note(t: number) {
    if (this.last !== null && t > this.last) this.total += Math.min(t - this.last, IDLE_CAP_MS);
    this.last = t;
  }

  get started(): boolean {
    return this.last !== null;
  }

  /** Worth logging: time has passed since the first note (a note, then a reset, is not). */
  get worthLogging(): boolean {
    return this.ms > 0;
  }

  get ms(): number {
    return Math.round(this.total);
  }
}

export interface LearnSummary {
  kind: LearnSession["kind"];
  subject: string;
  title: string;
  instrument?: Instrument;
  totalMs: number;
  /** Passes played to the end. */
  passes: number;
  sessions: number;
  lastTs: number;
  /** Songs: measures with the most stumbles in recent sessions, worst first. */
  stumbles: number[];
}

/**
 * Measures with the most unclean steps across these sessions, worst first,
 * at most `n`. Measures played cleanly every time are left out.
 */
export function stumbleMeasures(sessions: LearnSession[], n = 3): number[] {
  const bad = new Map<number, number>();
  for (const s of sessions) {
    for (const m of s.measures ?? []) {
      if (m.steps > m.clean) bad.set(m.measure, (bad.get(m.measure) ?? 0) + m.steps - m.clean);
    }
  }
  return [...bad].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, n).map(([m]) => m)
    .sort((a, b) => a - b);
}

/** One row per scale or song, most recently learned first. */
export function summarizeLearning(sessions: LearnSession[]): LearnSummary[] {
  const groups = new Map<string, LearnSession[]>();
  for (const s of sessions) {
    const key = `${s.kind}|${s.subject}|${s.instrument ?? "piano"}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()].map((g) => {
    g.sort((a, b) => a.ts - b.ts);
    const last = g[g.length - 1];
    return {
      kind: last.kind,
      subject: last.subject,
      title: last.title,
      ...(last.instrument ? { instrument: last.instrument } : {}),
      totalMs: g.reduce((sum, s) => sum + s.durationMs, 0),
      passes: g.filter((s) => s.complete).length,
      sessions: g.length,
      lastTs: last.ts,
      stumbles: stumbleMeasures(g.slice(-RECENT_STUMBLES)),
    };
  }).sort((a, b) => b.lastTs - a.lastTs);
}

/** "3 min 10 s", "1 h 5 min", "40 s". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "measure 5", "measures 5 and 9", "measures 5, 6 and 9". */
export function measureList(ms: number[]): string {
  if (ms.length === 1) return `measure ${ms[0]}`;
  return `measures ${ms.slice(0, -1).join(", ")} and ${ms[ms.length - 1]}`;
}
