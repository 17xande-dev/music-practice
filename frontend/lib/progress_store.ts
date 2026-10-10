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
import { cleanLearnSession, LEARN_KEY, type LearnSession, validLearnSession } from "./learn_log.ts";

export const SESSIONS_KEY = "mp.v1.sessions";
export const SETTINGS_KEY = "mp.v1.settings";
/** Sync state (docs/sync-api.md); absent means sync is off. */
export const SYNC_KEY = "mp.v1.sync";
/** Oldest sessions are dropped beyond this, to stay well inside the quota. */
export const MAX_SESSIONS = 2000;
export const EXPORT_APP = "music-practice";
export const EXPORT_VERSION = 1;

/** The three synced kinds, named as the server names them. */
export type Kind = "scale" | "song" | "learn";
export interface SyncEntry {
  kind: Kind;
  id: string;
}
export interface SyncState {
  email: string;
  cursor: number;
  pendingAdds: SyncEntry[];
  pendingDeletes: SyncEntry[];
  lastSyncAt: number | null;
}
export const entryKey = (e: SyncEntry) => `${e.kind}:${e.id}`;

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
  /** Learn: wait for each note, with hints, kept out of the graded history. */
  mode: "notes" | "tempo" | "learn";
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
  /** Keyboard hints (targets, next key, scale tint); off = a plain keyboard. Default on. */
  keyboardHints: boolean;
  /** Songs page: how the last song was practised, and which song it was. */
  songMode: "learn" | "notes" | "tempo" | "rubato" | "listen";
  /** Rubato's on-time window, as % of each note's length. */
  songRubato: number;
  /** Rubato's guide click: follows the player, or keeps the marked tempo. */
  songGuide: "follow" | "steady";
  songHands: "both" | "rh" | "lh";
  songTempo: number;
  songMetronome: boolean;
  songAccompany: boolean;
  songLoop: boolean;
  lastSong: string;
  /** Music sheets light or dark regardless of the site theme; "auto" follows it. */
  sheetTheme: "auto" | "light" | "dark";
  /** The site's theme, once picked with the header switch; absent follows the system. */
  theme: "light" | "dark";
  /** Songs: wrapped into systems, or one line scrolling right; and the notation size. */
  songView: "page" | "line";
  songZoom: number;
  /** While playing, the cursor flows with the music or jumps note to note. */
  songCursor: "flow" | "jump";
  /**
   * The measure range last practised in each song (by song id), written
   * measure numbers. Absent = the whole piece. Settings are not exported, so
   * neither is this; deleting a song drops its entry (removeSong).
   */
  songRanges: Record<string, { from: number; to: number }>;
}

/** Songs whose range is remembered; the oldest are forgotten beyond this. */
const MAX_SONG_RANGES = 500;

export interface ExportFile {
  app: typeof EXPORT_APP;
  version: number;
  exportedAt: string;
  sessions: Session[];
  /** Song runs; absent in exports made before songs existed. */
  songSessions?: SongSession[];
  /** Learn-mode log; absent in exports made before Learn mode existed. */
  learnSessions?: LearnSession[];
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
  if (["notes", "tempo", "learn"].includes(x.mode as string)) out.mode = x.mode as Settings["mode"];
  if (isNum(x.bpm) && x.bpm >= 40 && x.bpm <= 200) out.bpm = x.bpm;
  if ([1, 2, 4].includes(x.notesPerBeat as number)) out.notesPerBeat = x.notesPerBeat as number;
  if (isNum(x.latencyMs) && x.latencyMs >= 0 && x.latencyMs <= 300) out.latencyMs = x.latencyMs;
  if (typeof x.device === "string" && x.device.length <= 200) out.device = x.device;
  if (x.instrument === "piano" || x.instrument === "guitar") out.instrument = x.instrument;
  if (isCount(x.position) && x.position <= 12) out.position = x.position;
  if (isNum(x.a4) && x.a4 >= 415 && x.a4 <= 466) out.a4 = x.a4;
  if (typeof x.fingering === "boolean") out.fingering = x.fingering;
  if (typeof x.keyboardHints === "boolean") out.keyboardHints = x.keyboardHints;
  if (x.songGuide === "follow" || x.songGuide === "steady") out.songGuide = x.songGuide;
  if (isNum(x.songRubato) && x.songRubato >= 10 && x.songRubato <= 50) {
    out.songRubato = x.songRubato;
  }
  if (["learn", "notes", "tempo", "rubato", "listen"].includes(x.songMode as string)) {
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
  if (x.theme === "light" || x.theme === "dark") out.theme = x.theme;
  if (x.songView === "page" || x.songView === "line") out.songView = x.songView;
  if (x.songCursor === "flow" || x.songCursor === "jump") out.songCursor = x.songCursor;
  if (isObj(x.songRanges)) {
    const ranges: Settings["songRanges"] = {};
    for (const [id, r] of Object.entries(x.songRanges).slice(0, MAX_SONG_RANGES)) {
      if (id.length > 0 && id.length <= 64 && isObj(r) && isCount(r.from) && isCount(r.to)) {
        if (r.from >= 1 && r.to >= r.from) ranges[id] = { from: r.from, to: r.to };
      }
    }
    out.songRanges = ranges;
  }
  if (isNum(x.songZoom) && x.songZoom >= 0.6 && x.songZoom <= 2) out.songZoom = x.songZoom;
  if (["auto", "light", "dark"].includes(x.sheetTheme as string)) {
    out.sheetTheme = x.sheetTheme as Settings["sheetTheme"];
  }
  if (typeof x.audioDevice === "string" && x.audioDevice.length <= 200) {
    out.audioDevice = x.audioDevice;
  }
  return out;
}

// ---- Corrupt data -------------------------------------------------------
//
// Reads never throw: a bad record or key is skipped in memory so the page
// works. Nothing is deleted until the person agrees (see data_repair.ts):
// `scan` finds what is unreadable, `repair` removes exactly that.

type Raw = { state: "missing" } | { state: "corrupt" } | { state: "ok"; value: unknown };

/** One stored key that holds something unreadable, and what it would be cleaned to. */
export interface Scan {
  key: string;
  label: string;
  /** The whole key is unusable (not JSON, or the wrong shape): remove it. */
  corrupt: boolean;
  /** Records (or settings fields) that fail validation. */
  dropped: number;
  /** The value to write back when not `corrupt`. */
  cleaned: unknown;
}

export const STORE_LABELS: Record<string, string> = {
  [SESSIONS_KEY]: "Scale practice history",
  [SONG_SESSIONS_KEY]: "Song practice history",
  [LEARN_KEY]: "Learn log",
  [SETTINGS_KEY]: "Settings",
};

/** Null when the list is fine (or absent). Pure. */
export function scanList<T>(
  key: string,
  raw: Raw,
  valid: (x: unknown) => boolean,
  clean: (x: T) => T,
): Scan | null {
  const label = STORE_LABELS[key] ?? key;
  if (raw.state === "missing") return null;
  if (raw.state === "corrupt" || !Array.isArray(raw.value)) {
    return { key, label, corrupt: true, dropped: 0, cleaned: null };
  }
  const good = raw.value.filter(valid) as T[];
  const dropped = raw.value.length - good.length;
  return dropped ? { key, label, corrupt: false, dropped, cleaned: good.map(clean) } : null;
}

/** Fields of Settings that validSettings knows; others (a newer version's) are left alone. */
const SETTING_KEYS: readonly (keyof Settings)[] = [
  "tonic",
  "type",
  "hands",
  "octaves",
  "direction",
  "mode",
  "bpm",
  "notesPerBeat",
  "latencyMs",
  "device",
  "instrument",
  "position",
  "audioDevice",
  "a4",
  "fingering",
  "keyboardHints",
  "songMode",
  "songRubato",
  "songGuide",
  "songHands",
  "songTempo",
  "songMetronome",
  "songAccompany",
  "songLoop",
  "lastSong",
  "sheetTheme",
  "theme",
  "songView",
  "songZoom",
  "songCursor",
  "songRanges",
];

/** Null when every known field is valid (or the key is absent). Bad fields fall back to defaults. */
export function scanSettings(raw: Raw): Scan | null {
  const key = SETTINGS_KEY, label = STORE_LABELS[key];
  if (raw.state === "missing") return null;
  if (raw.state === "corrupt" || !isObj(raw.value)) {
    return { key, label, corrupt: true, dropped: 0, cleaned: null };
  }
  const cleaned = validSettings(raw.value);
  const dropped = SETTING_KEYS.filter((k) => k in (raw.value as object) && !(k in cleaned)).length;
  return dropped ? { key, label, corrupt: false, dropped, cleaned } : null;
}

function newId(): string {
  // randomUUID needs a secure context; fall back rather than fail on plain http.
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface KindSpec {
  key: string;
  valid: (x: unknown) => boolean;
  clean: (x: unknown) => { id: string; ts: number };
}
const KINDS: Record<Kind, KindSpec> = {
  scale: { key: SESSIONS_KEY, valid: validSession, clean: (x) => cleanSession(x as Session) },
  song: {
    key: SONG_SESSIONS_KEY,
    valid: validSongSession,
    clean: (x) => cleanSongSession(x as SongSession),
  },
  learn: {
    key: LEARN_KEY,
    valid: validLearnSession,
    clean: (x) => cleanLearnSession(x as LearnSession),
  },
};

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

  private readRaw(key: string): Raw {
    if (!this.available) return { state: "missing" };
    try {
      const raw = this.storage!.getItem(key);
      return raw === null ? { state: "missing" } : { state: "ok", value: JSON.parse(raw) };
    } catch {
      return { state: "corrupt" };
    }
  }

  /** Every stored key that holds something unreadable. Changes nothing, never throws. */
  scan(): Scan[] {
    return [
      scanList<Session>(SESSIONS_KEY, this.readRaw(SESSIONS_KEY), validSession, cleanSession),
      scanList<SongSession>(
        SONG_SESSIONS_KEY,
        this.readRaw(SONG_SESSIONS_KEY),
        validSongSession,
        cleanSongSession,
      ),
      scanList<LearnSession>(
        LEARN_KEY,
        this.readRaw(LEARN_KEY),
        validLearnSession,
        cleanLearnSession,
      ),
      scanSettings(this.readRaw(SETTINGS_KEY)),
    ].filter((x): x is Scan => x !== null);
  }

  /** Delete the unreadable keys and records `scan` finds, writing the rest back. */
  repair(): boolean {
    let ok = true;
    for (const sc of this.scan()) {
      if (sc.corrupt) {
        try {
          this.storage!.removeItem(sc.key);
        } catch {
          ok = false;
        }
      } else ok = this.write(sc.key, sc.cleaned) && ok;
    }
    return ok;
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
    if (saved) this.queueAdds([{ kind: "scale", id: session.id }]);
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
    if (saved) this.queueAdds([{ kind: "song", id: session.id }]);
    return { session, saved, previousBest };
  }

  /** Every valid stored learn session, oldest first. */
  learnSessions(): LearnSession[] {
    const raw = this.read(LEARN_KEY);
    return Array.isArray(raw)
      ? raw.filter(validLearnSession).map(cleanLearnSession).sort((a, b) => a.ts - b.ts)
      : [];
  }

  /** Log time spent in Learn mode. Never touches the graded history. */
  addLearn(run: Omit<LearnSession, "id">): { session: LearnSession; saved: boolean } {
    const session: LearnSession = { ...run, id: newId() };
    const all = this.learnSessions();
    all.push(session);
    const saved = this.write(LEARN_KEY, all.slice(-MAX_SESSIONS));
    if (saved) this.queueAdds([{ kind: "learn", id: session.id }]);
    return { session, saved };
  }

  /** Forget a song's history (when the song itself is deleted). */
  removeSong(songId: string): boolean {
    this.setSongRange(songId, null);
    const songs = this.songSessions();
    const learn = this.learnSessions();
    const gone = songs.filter((s) => s.songId === songId);
    const goneLearn = learn.filter((s) => s.kind === "song" && s.subject === songId);
    const a = this.write(SONG_SESSIONS_KEY, songs.filter((s) => s.songId !== songId));
    const b = this.write(
      LEARN_KEY,
      learn.filter((s) => !(s.kind === "song" && s.subject === songId)),
    );
    this.queueDeletes([
      ...(a ? gone.map((s) => ({ kind: "song" as const, id: s.id })) : []),
      ...(b ? goneLearn.map((s) => ({ kind: "learn" as const, id: s.id })) : []),
    ]);
    return a && b;
  }

  clear(): boolean {
    const gone: SyncEntry[] = [];
    const ok = (kind: Kind, ids: string[], saved: boolean) => {
      if (saved) gone.push(...ids.map((id) => ({ kind, id })));
      return saved;
    };
    const a = ok("scale", this.sessions().map((s) => s.id), this.write(SESSIONS_KEY, []));
    const b = ok("song", this.songSessions().map((s) => s.id), this.write(SONG_SESSIONS_KEY, []));
    const c = ok("learn", this.learnSessions().map((s) => s.id), this.write(LEARN_KEY, []));
    this.queueDeletes(gone);
    return a && b && c;
  }

  // ---- Sync support -------------------------------------------------------
  // The store only keeps the sync state and the queues; talking to the
  // server is lib/sync.ts. See docs/sync-api.md.

  /** The stored runs of one kind, oldest first. */
  list(kind: Kind): { id: string; ts: number }[] {
    return kind === "scale"
      ? this.sessions()
      : kind === "song"
      ? this.songSessions()
      : this.learnSessions();
  }

  /**
   * Union records into one kind by id (what is already here wins), oldest
   * first, capped. Used for imports and for runs pulled from the server;
   * merging the same records again changes nothing. The cap drops the
   * oldest quietly: it is never a deletion to sync.
   */
  mergeRecords(
    kind: Kind,
    records: unknown[],
  ): { addedIds: string[]; duplicate: number; invalid: number; saved: boolean } {
    const spec = KINDS[kind];
    const all = this.list(kind);
    const ids = new Set(all.map((s) => s.id));
    const addedIds: string[] = [];
    let duplicate = 0, invalid = 0;
    for (const r of records) {
      if (!spec.valid(r)) invalid++;
      else if (ids.has((r as { id: string }).id)) duplicate++;
      else {
        const clean = spec.clean(r);
        all.push(clean);
        ids.add(clean.id);
        addedIds.push(clean.id);
      }
    }
    if (!addedIds.length) return { addedIds, duplicate, invalid, saved: true };
    all.sort((a, b) => a.ts - b.ts);
    const saved = this.write(spec.key, all.slice(-MAX_SESSIONS));
    return { addedIds: saved ? addedIds : [], duplicate, invalid, saved };
  }

  /** Delete runs by id; returns the ids that were actually here. */
  removeIds(kind: Kind, ids: string[]): string[] {
    const drop = new Set(ids);
    const all = this.list(kind);
    const gone = all.filter((s) => drop.has(s.id)).map((s) => s.id);
    if (gone.length && !this.write(KINDS[kind].key, all.filter((s) => !drop.has(s.id)))) return [];
    return gone;
  }

  /** Sync state, or null when sync is off (signed out, or never signed in here). */
  syncState(): SyncState | null {
    const raw = this.read(SYNC_KEY);
    if (!isObj(raw) || typeof raw.email !== "string" || !isNum(raw.cursor)) return null;
    const entries = (v: unknown): SyncEntry[] =>
      Array.isArray(v)
        ? v.filter((e): e is SyncEntry =>
          isObj(e) && typeof e.id === "string" && (e.kind === "scale" || e.kind === "song" ||
            e.kind === "learn")
        ).map((e) => ({ kind: e.kind, id: e.id }))
        : [];
    return {
      email: raw.email,
      cursor: raw.cursor,
      pendingAdds: entries(raw.pendingAdds),
      pendingDeletes: entries(raw.pendingDeletes),
      lastSyncAt: isNum(raw.lastSyncAt) ? raw.lastSyncAt : null,
    };
  }

  saveSyncState(state: SyncState): boolean {
    return this.write(SYNC_KEY, state);
  }

  /** Sync off. Local history stays. */
  clearSyncState(): void {
    if (!this.available) return;
    try {
      this.storage!.removeItem(SYNC_KEY);
    } catch { /* nothing more to do */ }
  }

  /** Change the sync state in place; does nothing while sync is off. */
  updateSync(change: (s: SyncState) => void): void {
    const s = this.syncState();
    if (!s) return;
    change(s);
    this.saveSyncState(s);
  }

  /** Queue new runs for the next sync (no-op while sync is off). */
  queueAdds(entries: SyncEntry[]): void {
    if (!entries.length) return;
    this.updateSync((s) => {
      const have = new Set(s.pendingAdds.map(entryKey));
      for (const e of entries) if (!have.has(entryKey(e))) s.pendingAdds.push(e);
    });
  }

  /** Queue deletions, and forget any not-yet-sent adds of the same runs. */
  queueDeletes(entries: SyncEntry[]): void {
    if (!entries.length) return;
    this.updateSync((s) => {
      const gone = new Set(entries.map(entryKey));
      s.pendingAdds = s.pendingAdds.filter((e) => !gone.has(entryKey(e)));
      const have = new Set(s.pendingDeletes.map(entryKey));
      for (const e of entries) if (!have.has(entryKey(e))) s.pendingDeletes.push(e);
    });
  }

  /** Every local run, as sync entries (the "add this browser's runs" offer). */
  allEntries(): SyncEntry[] {
    return (["scale", "song", "learn"] as const).flatMap((kind) =>
      this.list(kind).map((r) => ({ kind, id: r.id }))
    );
  }

  settings(): Partial<Settings> {
    return validSettings(this.read(SETTINGS_KEY));
  }

  /** The range remembered for a song, or undefined for the whole piece. */
  songRange(songId: string): { from: number; to: number } | undefined {
    return this.settings().songRanges?.[songId];
  }

  /** Remember a song's range; null (the whole piece) forgets it. */
  setSongRange(songId: string, range: { from: number; to: number } | null): void {
    const was = this.songRange(songId);
    if (was?.from === range?.from && was?.to === range?.to) return;
    const all = { ...this.settings().songRanges };
    if (range) all[songId] = { from: range.from, to: range.to };
    else delete all[songId];
    this.saveSettings({ songRanges: all });
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
      learnSessions: this.learnSessions(),
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
    let added = 0, duplicate = 0, invalid = 0, saved = true;
    const queued: SyncEntry[] = [];
    // Song runs and Learn time only exist in newer exports.
    const parts: [Kind, unknown][] = [
      ["scale", parsed.sessions],
      ["song", parsed.songSessions],
      ["learn", parsed.learnSessions],
    ];
    for (const [kind, records] of parts) {
      if (!Array.isArray(records)) continue;
      const r = this.mergeRecords(kind, records);
      added += r.addedIds.length;
      duplicate += r.duplicate;
      invalid += r.invalid;
      saved = r.saved && saved;
      if (r.saved) queued.push(...r.addedIds.map((id) => ({ kind, id })));
    }
    this.queueAdds(queued);
    return { added, duplicate, invalid, saved };
  }
}
