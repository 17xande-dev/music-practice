// Practice history and settings, kept in the browser's localStorage.
//
// Stage 1 has no accounts, so this is the only record. It is versioned
// (the "v1" in every key, and `version` in exports) and exportable as JSON,
// which is also how stage 2 will import it into an account.
//
// localStorage can be missing or throw (private windows, blocked site
// data, a full quota), so every access is guarded and the store reports
// whether it is working: practice must never break because history cannot
// be saved.

import type { ExerciseOptions, PitchName, ScaleType } from "./theory.ts";
import { SCALES } from "./theory.ts";
import {
  betterSong,
  cleanSongSession,
  SONG_SESSIONS_KEY,
  songKey,
  type SongSession,
  validSongSession,
} from "./song_session.ts";

export const SESSIONS_KEY = "mp.v1.sessions";
export const SETTINGS_KEY = "mp.v1.settings";
/** Oldest sessions are dropped beyond this, to stay well inside the quota. */
export const MAX_SESSIONS = 2000;
export const EXPORT_APP = "music-practice";
export const EXPORT_VERSION = 1;

export interface SessionTiming {
  bpm: number;
  notesPerBeat: number;
  onTime: number;
  early: number;
  late: number;
  missed: number;
  meanAbsMs: number | null;
  meanSignedMs: number | null;
}

export type Instrument = "piano" | "guitar";

export interface Session {
  id: string;
  /** Absent on sessions recorded before guitar support: those are piano. */
  instrument?: Instrument;
  /** Epoch milliseconds when the run finished. */
  ts: number;
  tonic: PitchName;
  type: ScaleType;
  hands: ExerciseOptions["hands"];
  octaves: number;
  direction: ExerciseOptions["direction"];
  mode: "notes" | "tempo";
  total: number;
  correct: number;
  accuracy: number;
  wrongNotes: number;
  durationMs: number;
  unevenness: number | null;
  velocityStd: number | null;
  notTogether: number;
  timing: SessionTiming | null;
}

export interface Settings {
  tonic: PitchName;
  type: ScaleType;
  hands: ExerciseOptions["hands"];
  octaves: number;
  direction: ExerciseOptions["direction"];
  mode: "notes" | "tempo";
  bpm: number;
  notesPerBeat: number;
  latencyMs: number;
  /** MIDI input name (ids are not stable across reconnects). */
  device: string;
  instrument: Instrument;
  /** Guitar fretboard position: 0 = open, 1–12 = index finger at that fret. */
  position: number;
  /** Audio input label for guitar (device ids change across sessions). */
  audioDevice: string;
  /** Tuning reference, A4 in Hz (the tuner and guitar grading use it). */
  a4: number;
  /** Show finger numbers on the staff, keyboard and fretboard. */
  fingering: boolean;
  /** Songs page: how the last song was practised, and which song it was. */
  songMode: "notes" | "tempo" | "listen";
  songHands: "both" | "rh" | "lh";
  songTempo: number;
  songMetronome: boolean;
  songAccompany: boolean;
  songLoop: boolean;
  lastSong: string;
  /** Music sheets light or dark regardless of the site theme; "auto" follows it. */
  sheetTheme: "auto" | "light" | "dark";
}

export interface ExportFile {
  app: typeof EXPORT_APP;
  version: number;
  exportedAt: string;
  sessions: Session[];
  /** Song runs; absent in exports made before songs existed. */
  songSessions?: SongSession[];
}

/** Sessions of the same exercise: comparable for personal bests and trends. */
export function exerciseKey(
  s: Pick<Session, "tonic" | "type" | "hands" | "octaves" | "direction" | "mode" | "instrument">,
) {
  const key: (string | number)[] = [
    s.tonic.letter,
    s.tonic.acc,
    s.type,
    s.hands,
    s.octaves,
    s.direction,
    s.mode,
  ];
  // Guitar and piano bests are separate exercises. Piano keys are unchanged,
  // so bests recorded before guitar support still match.
  if (s.instrument === "guitar") key.push("guitar");
  return key.join("|");
}

/** The same scale regardless of how it was practised, for the per-scale view. */
export function scaleKey(s: Pick<Session, "tonic" | "type">) {
  return `${s.tonic.letter}${s.tonic.acc}|${s.type}`;
}

/**
 * Whether `a` is a better run than `b` of the same exercise: higher
 * accuracy first; then, for tempo, closer to the beat; for notes-only,
 * faster.
 */
export function better(a: Session, b: Session): boolean {
  if (a.accuracy !== b.accuracy) return a.accuracy > b.accuracy;
  if (a.timing && b.timing) {
    return (a.timing.meanAbsMs ?? Infinity) < (b.timing.meanAbsMs ?? Infinity);
  }
  return a.durationMs < b.durationMs;
}

// ---- Validation ---------------------------------------------------------
//
// Anything read back — from storage another version wrote, or from a file
// someone imported — is checked field by field. A record that fails is
// dropped, never half-used.

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x);
const isCount = (x: unknown): x is number => isNum(x) && x >= 0 && Number.isInteger(x);
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];

function validPitch(x: unknown): x is PitchName {
  return isObj(x) && LETTERS.includes(x.letter as string) && isNum(x.acc) &&
    Number.isInteger(x.acc) &&
    Math.abs(x.acc) <= 2;
}

function validTiming(x: unknown): x is SessionTiming | null {
  if (x === null) return true;
  return isObj(x) && isNum(x.bpm) && x.bpm > 0 && isNum(x.notesPerBeat) && x.notesPerBeat > 0 &&
    isCount(x.onTime) && isCount(x.early) && isCount(x.late) && isCount(x.missed) &&
    isNumOrNull(x.meanAbsMs) && isNumOrNull(x.meanSignedMs);
}

export function validSession(x: unknown): x is Session {
  return isObj(x) &&
    typeof x.id === "string" && x.id.length > 0 && x.id.length <= 64 &&
    isNum(x.ts) && x.ts > 0 &&
    validPitch(x.tonic) &&
    typeof x.type === "string" && Object.hasOwn(SCALES, x.type) &&
    ["rh", "lh", "both"].includes(x.hands as string) &&
    isCount(x.octaves) && x.octaves >= 1 && x.octaves <= 4 &&
    ["up", "updown"].includes(x.direction as string) &&
    ["notes", "tempo"].includes(x.mode as string) &&
    isCount(x.total) && x.total > 0 && isCount(x.correct) && x.correct <= x.total &&
    isNum(x.accuracy) && x.accuracy >= 0 && x.accuracy <= 1 &&
    isCount(x.wrongNotes) && isNum(x.durationMs) && x.durationMs >= 0 &&
    isNumOrNull(x.unevenness) && isNumOrNull(x.velocityStd) && isCount(x.notTogether) &&
    validTiming(x.timing) && (x.mode === "tempo") === (x.timing !== null) &&
    (x.instrument === undefined || x.instrument === "piano" || x.instrument === "guitar");
}

/**
 * A validated session rebuilt from its known fields only, so an imported
 * file cannot smuggle extra (or enormous) properties into storage.
 */
export function cleanSession(s: Session): Session {
  const t = s.timing;
  return {
    id: s.id,
    ts: s.ts,
    ...(s.instrument ? { instrument: s.instrument } : {}),
    tonic: { letter: s.tonic.letter, acc: s.tonic.acc },
    type: s.type,
    hands: s.hands,
    octaves: s.octaves,
    direction: s.direction,
    mode: s.mode,
    total: s.total,
    correct: s.correct,
    accuracy: s.accuracy,
    wrongNotes: s.wrongNotes,
    durationMs: s.durationMs,
    unevenness: s.unevenness,
    velocityStd: s.velocityStd,
    notTogether: s.notTogether,
    timing: t && {
      bpm: t.bpm,
      notesPerBeat: t.notesPerBeat,
      onTime: t.onTime,
      early: t.early,
      late: t.late,
      missed: t.missed,
      meanAbsMs: t.meanAbsMs,
      meanSignedMs: t.meanSignedMs,
    },
  };
}

/** Settings are advisory: keep each valid field, drop the rest. */
export function validSettings(x: unknown): Partial<Settings> {
  if (!isObj(x)) return {};
  const out: Partial<Settings> = {};
  if (validPitch(x.tonic)) out.tonic = x.tonic;
  if (typeof x.type === "string" && Object.hasOwn(SCALES, x.type)) out.type = x.type as ScaleType;
  if (["rh", "lh", "both"].includes(x.hands as string)) out.hands = x.hands as Settings["hands"];
  if (isCount(x.octaves) && x.octaves >= 1 && x.octaves <= 4) out.octaves = x.octaves;
  if (["up", "updown"].includes(x.direction as string)) {
    out.direction = x.direction as Settings["direction"];
  }
  if (["notes", "tempo"].includes(x.mode as string)) out.mode = x.mode as Settings["mode"];
  if (isNum(x.bpm) && x.bpm >= 40 && x.bpm <= 200) out.bpm = x.bpm;
  if ([1, 2, 4].includes(x.notesPerBeat as number)) out.notesPerBeat = x.notesPerBeat as number;
  if (isNum(x.latencyMs) && x.latencyMs >= 0 && x.latencyMs <= 300) out.latencyMs = x.latencyMs;
  if (typeof x.device === "string" && x.device.length <= 200) out.device = x.device;
  if (x.instrument === "piano" || x.instrument === "guitar") out.instrument = x.instrument;
  if (isCount(x.position) && x.position <= 12) out.position = x.position;
  if (isNum(x.a4) && x.a4 >= 415 && x.a4 <= 466) out.a4 = x.a4;
  if (typeof x.fingering === "boolean") out.fingering = x.fingering;
  if (["notes", "tempo", "listen"].includes(x.songMode as string)) {
    out.songMode = x.songMode as Settings["songMode"];
  }
  if (["both", "rh", "lh"].includes(x.songHands as string)) {
    out.songHands = x.songHands as Settings["songHands"];
  }
  if (isNum(x.songTempo) && x.songTempo >= 10 && x.songTempo <= 200) out.songTempo = x.songTempo;
  for (const k of ["songMetronome", "songAccompany", "songLoop"] as const) {
    if (typeof x[k] === "boolean") out[k] = x[k] as boolean;
  }
  if (typeof x.lastSong === "string" && x.lastSong.length <= 64) out.lastSong = x.lastSong;
  if (["auto", "light", "dark"].includes(x.sheetTheme as string)) {
    out.sheetTheme = x.sheetTheme as Settings["sheetTheme"];
  }
  if (typeof x.audioDevice === "string" && x.audioDevice.length <= 200) {
    out.audioDevice = x.audioDevice;
  }
  return out;
}

function newId(): string {
  // randomUUID needs a secure context; fall back rather than fail on plain http.
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---- The store ----------------------------------------------------------

export class ProgressStore {
  /** False when storage is unavailable; the page says history won't be kept. */
  readonly available: boolean;

  constructor(private readonly storage: Storage | null) {
    this.available = ProgressStore.probe(storage);
  }

  /** Default store over window.localStorage, which can itself throw on access. */
  static fromWindow(): ProgressStore {
    let s: Storage | null = null;
    try {
      s = globalThis.localStorage ?? null;
    } catch {
      s = null;
    }
    return new ProgressStore(s);
  }

  private static probe(s: Storage | null): boolean {
    if (!s) return false;
    try {
      const k = "mp.v1.probe";
      s.setItem(k, "1");
      s.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  private read(key: string): unknown {
    if (!this.available) return null;
    try {
      const raw = this.storage!.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null; // unreadable or corrupt: treat as empty rather than break
    }
  }

  private write(key: string, value: unknown): boolean {
    if (!this.available) return false;
    try {
      this.storage!.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // quota exceeded, or storage revoked mid-session
    }
  }

  /** Every valid stored session, oldest first. */
  sessions(): Session[] {
    const raw = this.read(SESSIONS_KEY);
    return Array.isArray(raw)
      ? raw.filter(validSession).map(cleanSession).sort((a, b) => a.ts - b.ts)
      : [];
  }

  /**
   * Record a finished run. Returns the stored session and the previous best
   * of the same exercise (so the page can say "new personal best"), and
   * whether it was actually saved.
   */
  add(
    run: Omit<Session, "id">,
  ): { session: Session; saved: boolean; previousBest: Session | null } {
    const session: Session = { ...run, id: newId() };
    const all = this.sessions();
    const key = exerciseKey(session);
    const previousBest = all.filter((s) => exerciseKey(s) === key)
      .reduce<Session | null>((best, s) => (!best || better(s, best) ? s : best), null);
    all.push(session);
    const saved = this.write(SESSIONS_KEY, all.slice(-MAX_SESSIONS));
    return { session, saved, previousBest };
  }

  /** Every valid stored song session, oldest first. */
  songSessions(): SongSession[] {
    const raw = this.read(SONG_SESSIONS_KEY);
    return Array.isArray(raw)
      ? raw.filter(validSongSession).map(cleanSongSession).sort((a, b) => a.ts - b.ts)
      : [];
  }

  /** Record a finished song run, with the previous best of the same practice. */
  addSong(
    run: Omit<SongSession, "id">,
  ): { session: SongSession; saved: boolean; previousBest: SongSession | null } {
    const session: SongSession = { ...run, id: newId() };
    const all = this.songSessions();
    const key = songKey(session);
    const previousBest = all.filter((s) => songKey(s) === key)
      .reduce<SongSession | null>((best, s) => (!best || betterSong(s, best) ? s : best), null);
    all.push(session);
    const saved = this.write(SONG_SESSIONS_KEY, all.slice(-MAX_SESSIONS));
    return { session, saved, previousBest };
  }

  /** Forget a song's history (when the song itself is deleted). */
  removeSong(songId: string): boolean {
    return this.write(SONG_SESSIONS_KEY, this.songSessions().filter((s) => s.songId !== songId));
  }

  clear(): boolean {
    const a = this.write(SESSIONS_KEY, []);
    const b = this.write(SONG_SESSIONS_KEY, []);
    return a && b;
  }

  settings(): Partial<Settings> {
    return validSettings(this.read(SETTINGS_KEY));
  }

  saveSettings(patch: Partial<Settings>): void {
    this.write(SETTINGS_KEY, { ...this.settings(), ...validSettings(patch) });
  }

  exportJSON(now = new Date()): string {
    const file: ExportFile = {
      app: EXPORT_APP,
      version: EXPORT_VERSION,
      exportedAt: now.toISOString(),
      sessions: this.sessions(),
      songSessions: this.songSessions(),
    };
    return JSON.stringify(file, null, 2);
  }

  /**
   * Merge an export into the stored history. Sessions already present (by
   * id) are skipped, so importing the same file twice changes nothing;
   * invalid records are counted and dropped.
   */
  importJSON(text: string): { added: number; duplicate: number; invalid: number; saved: boolean } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("That file is not valid JSON.");
    }
    if (!isObj(parsed) || parsed.app !== EXPORT_APP || !Array.isArray(parsed.sessions)) {
      throw new Error("That file is not a Music Practice export.");
    }
    if (!isNum(parsed.version) || parsed.version > EXPORT_VERSION) {
      throw new Error("That export is from a newer version of Music Practice.");
    }
    const all = this.sessions();
    const ids = new Set(all.map((s) => s.id));
    let added = 0, duplicate = 0, invalid = 0;
    for (const s of parsed.sessions) {
      if (!validSession(s)) invalid++;
      else if (ids.has(s.id)) duplicate++;
      else {
        all.push(cleanSession(s));
        ids.add(s.id);
        added++;
      }
    }
    all.sort((a, b) => a.ts - b.ts);
    let saved = added === 0 || this.write(SESSIONS_KEY, all.slice(-MAX_SESSIONS));

    // Song runs, in exports that have them.
    if (Array.isArray(parsed.songSessions)) {
      const songs = this.songSessions();
      const songIds = new Set(songs.map((s) => s.id));
      let songsAdded = 0;
      for (const s of parsed.songSessions) {
        if (!validSongSession(s)) invalid++;
        else if (songIds.has(s.id)) duplicate++;
        else {
          songs.push(cleanSongSession(s));
          songIds.add(s.id);
          songsAdded++;
        }
      }
      songs.sort((a, b) => a.ts - b.ts);
      if (songsAdded) saved = this.write(SONG_SESSIONS_KEY, songs.slice(-MAX_SESSIONS)) && saved;
      added += songsAdded;
    }
    return { added, duplicate, invalid, saved };
  }
}
