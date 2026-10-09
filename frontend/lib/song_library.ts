// The songs someone has uploaded, kept in their browser's IndexedDB: scores
// can be megabytes, too big for localStorage's few-MB quota. Nothing is
// uploaded to the server. Like the progress store, every failure is
// reported rather than thrown at the page: a blocked or private-mode
// IndexedDB means songs can still be opened, just not kept.

import { planStarterMigration } from "./starters.ts";

const DB_NAME = "mp.v1";
const STORE = "songs";
export const MAX_SONG_BYTES = 10 * 1024 * 1024;

export type SongFormat = "musicxml" | "mxl";

export interface SongMeta {
  id: string;
  title: string;
  composer: string;
  fileName: string;
  format: SongFormat;
  size: number;
  added: number;
  lastPractised: number | null;
}

export interface SongRecord extends SongMeta {
  data: ArrayBuffer;
}

/**
 * Which kind of file this is: a zip (compressed .mxl) by its "PK" signature,
 * otherwise XML if it looks like a MusicXML document. Null for anything else.
 * The bytes decide, not the name: files are often misnamed.
 */
export function songFormat(bytes: Uint8Array): SongFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3) return "mxl";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /<(score-partwise|score-timewise)\b/.test(head) ? "musicxml" : null;
}

/** Why an upload can't be used, or null if it can. */
export function uploadProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0) return `${name} is empty.`;
  if (bytes.length > MAX_SONG_BYTES) {
    return `${name} is over ${MAX_SONG_BYTES / 1024 / 1024} MB, too big for a score.`;
  }
  if (!songFormat(bytes)) {
    return `${name} isn't a MusicXML file. Export the score as MusicXML (.musicxml or .mxl) ` +
      "from MuseScore, Sibelius, Finale or Dorico.";
  }
  return null;
}

/** A readable title from a file name: "bach_minuet-in-g.mxl" → "bach minuet in g". */
export function titleFromFileName(name: string): string {
  return name.replace(/\.(musicxml|mxl|xml)$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class SongLibrary {
  private constructor(private readonly db: IDBDatabase) {}

  /** Open the library, or null when IndexedDB is unavailable or blocked. */
  static async open(): Promise<SongLibrary | null> {
    try {
      if (!globalThis.indexedDB) return null;
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      return new SongLibrary(await request(req));
    } catch {
      return null;
    }
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  /** Every song, without its file, most recently practised (or added) first. */
  async list(): Promise<SongMeta[]> {
    const all = await request(this.store("readonly").getAll()) as SongRecord[];
    return all
      .map(({ data: _data, ...meta }) => meta)
      .sort((a, b) => (b.lastPractised ?? b.added) - (a.lastPractised ?? a.added));
  }

  async get(id: string): Promise<SongRecord | null> {
    return (await request(this.store("readonly").get(id)) as SongRecord | undefined) ?? null;
  }

  async add(
    meta: Omit<SongMeta, "id" | "added" | "lastPractised" | "size">,
    data: ArrayBuffer,
    /** A fixed id (starters); otherwise a random one. */
    id: string = newId(),
  ): Promise<SongRecord> {
    const rec: SongRecord = {
      ...meta,
      id,
      size: data.byteLength,
      added: Date.now(),
      lastPractised: null,
      data,
    };
    await request(this.store("readwrite").put(rec));
    return rec;
  }

  async update(id: string, patch: Partial<Pick<SongMeta, "title" | "lastPractised">>) {
    const rec = await this.get(id);
    if (rec) await request(this.store("readwrite").put({ ...rec, ...patch }));
  }

  async remove(id: string) {
    await request(this.store("readwrite").delete(id));
  }

  /**
   * Which starter copies sit under random ids, and where they go; changes
   * nothing. Pass the result to `applyStarterMigration` once the history that
   * refers to the old ids has been rewritten.
   */
  async planStarterMigration() {
    return planStarterMigration(await this.list());
  }

  /** Rename each kept copy to its starter id and delete the other copies. */
  async applyStarterMigration(plan: ReturnType<typeof planStarterMigration>) {
    const copies = new Map<string, SongRecord>();
    for (const [target, oldId] of plan.keep) {
      const rec = await this.get(oldId);
      if (rec) copies.set(target, rec);
    }
    const lastPractised = new Map<string, number | null>();
    for (const [oldId, target] of plan.remap) {
      const m = (await this.get(oldId))?.lastPractised ?? null;
      const prev = lastPractised.get(target) ?? null;
      lastPractised.set(target, m === null ? prev : Math.max(prev ?? 0, m));
    }
    for (const [target, rec] of copies) {
      await request(
        this.store("readwrite").put({
          ...rec,
          id: target,
          lastPractised: lastPractised.get(target) ?? rec.lastPractised,
        }),
      );
    }
    for (const [target, last] of lastPractised) {
      if (!copies.has(target) && last !== null) await this.update(target, { lastPractised: last });
    }
    for (const oldId of plan.remap.keys()) await this.remove(oldId);
  }
}
