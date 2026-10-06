// A finished run through a song (or part of one), as kept in the history.
// Stored beside the scale sessions, under its own key, and validated the
// same way: anything read back is checked field by field and rebuilt.

export const SONG_SESSIONS_KEY = "mp.v1.songSessions";
/** Measures kept per session for the heat-map history. */
export const MAX_MEASURES = 1000;

export interface SongMeasure {
  measure: number;
  steps: number;
  clean: number;
}

export interface SongSession {
  id: string;
  ts: number;
  songId: string;
  /** The title when played, so history still reads if the song is deleted. */
  title: string;
  hands: "both" | "rh" | "lh";
  /** Written measure range practised, inclusive. */
  from: number;
  to: number;
  /** Wait mode, in time with the metronome, or rubato (timing by the player's own tempo). */
  mode: "notes" | "tempo" | "rubato";
  /** Rubato: the on-time window, as % of each note's length. */
  rubatoPct?: number;
  /** Tempo as % of the marked tempo (tempo mode; 100 otherwise). */
  tempoPct: number;
  total: number;
  correct: number;
  accuracy: number;
  wrongNotes: number;
  durationMs: number;
  timing: {
    onTime: number;
    early: number;
    late: number;
    missed: number;
    meanAbsMs: number | null;
    meanSignedMs: number | null;
  } | null;
  measures: SongMeasure[];
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNumOrNull = (x: unknown) => x === null || isNum(x);
const isCount = (x: unknown): x is number => isNum(x) && x >= 0 && Number.isInteger(x);
const isStr = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= max;

function validMeasure(x: unknown): x is SongMeasure {
  return isObj(x) && isCount(x.measure) && isCount(x.steps) && isCount(x.clean) &&
    x.clean <= x.steps;
}

export function validSongSession(x: unknown): x is SongSession {
  if (!isObj(x)) return false;
  const t = x.timing;
  const timingOk = t === null ||
    (isObj(t) && isCount(t.onTime) && isCount(t.early) && isCount(t.late) &&
      isCount(t.missed) && isNumOrNull(t.meanAbsMs) && isNumOrNull(t.meanSignedMs));
  return isStr(x.id, 64) && isNum(x.ts) && x.ts > 0 &&
    isStr(x.songId, 64) && isStr(x.title, 300) &&
    ["both", "rh", "lh"].includes(x.hands as string) &&
    isCount(x.from) && isCount(x.to) && x.from >= 1 && x.to >= x.from &&
    ["notes", "tempo", "rubato"].includes(x.mode as string) &&
    (x.rubatoPct === undefined || (isNum(x.rubatoPct) && x.rubatoPct >= 10 && x.rubatoPct <= 50)) &&
    isNum(x.tempoPct) && x.tempoPct >= 10 && x.tempoPct <= 200 &&
    isCount(x.total) && x.total > 0 && isCount(x.correct) && x.correct <= x.total &&
    isNum(x.accuracy) && x.accuracy >= 0 && x.accuracy <= 1 &&
    isCount(x.wrongNotes) && isNum(x.durationMs) && x.durationMs >= 0 &&
    timingOk && (x.mode !== "notes") === (t !== null) &&
    Array.isArray(x.measures) && x.measures.length <= MAX_MEASURES &&
    x.measures.every(validMeasure);
}

/** Rebuilt from known fields only. */
export function cleanSongSession(s: SongSession): SongSession {
  const t = s.timing;
  return {
    id: s.id,
    ts: s.ts,
    songId: s.songId,
    title: s.title,
    hands: s.hands,
    from: s.from,
    to: s.to,
    mode: s.mode,
    ...(s.rubatoPct !== undefined ? { rubatoPct: s.rubatoPct } : {}),
    tempoPct: s.tempoPct,
    total: s.total,
    correct: s.correct,
    accuracy: s.accuracy,
    wrongNotes: s.wrongNotes,
    durationMs: s.durationMs,
    timing: t && {
      onTime: t.onTime,
      early: t.early,
      late: t.late,
      missed: t.missed,
      meanAbsMs: t.meanAbsMs,
      meanSignedMs: t.meanSignedMs,
    },
    measures: s.measures.map((m) => ({ measure: m.measure, steps: m.steps, clean: m.clean })),
  };
}

/**
 * Runs of the same practice: same song, hands, range and mode. Tempo % is
 * left out so a best at 80% is still the one to beat at 90%.
 */
export function songKey(s: Pick<SongSession, "songId" | "hands" | "from" | "to" | "mode">) {
  return [s.songId, s.hands, s.from, s.to, s.mode].join("|");
}

/** Higher accuracy wins; then faster tempo; then closer timing (or quicker, waiting). */
export function betterSong(a: SongSession, b: SongSession): boolean {
  if (a.accuracy !== b.accuracy) return a.accuracy > b.accuracy;
  if (a.tempoPct !== b.tempoPct) return a.tempoPct > b.tempoPct;
  if (a.timing && b.timing) {
    return (a.timing.meanAbsMs ?? Infinity) < (b.timing.meanAbsMs ?? Infinity);
  }
  return a.durationMs < b.durationMs;
}
