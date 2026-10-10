// When to sync: on load, on coming back to the tab or the network, and a few
// seconds after a run is recorded. Shared by the practice, songs and
// progress pages. Pages other than Progress never ask /api/me; they only
// sync if sync is already on, and a 401 turns it off (see sync.ts).

import type { ProgressStore } from "./progress_store.ts";
import { type FetchFn, sync, type SyncResult } from "./sync.ts";

/** Let a few runs in a row go up as one request. */
const DEBOUNCE_MS = 5000;

export interface SyncOptions {
  /** Sync when the page loads (Progress does its own, after checking /api/me). */
  onLoad?: boolean;
  /** Called after every sync that ran, with its result. */
  onResult?: (r: SyncResult) => void;
  fetch?: FetchFn;
}

export interface Syncer {
  /** Sync soon (debounced): call after recording a run or removing a song. */
  schedule(): void;
  /** Sync now; resolves to the result, or null if sync is off. */
  now(): Promise<SyncResult | null>;
}

export function installSync(store: ProgressStore, opts: SyncOptions = {}): Syncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = async (): Promise<SyncResult | null> => {
    clearTimeout(timer);
    if (!store.syncState()) return null;
    const r = await sync(store, opts.fetch);
    opts.onResult?.(r);
    return r;
  };
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void now();
  });
  addEventListener("online", () => void now());
  if (opts.onLoad ?? true) void now();
  return {
    schedule() {
      if (!store.syncState()) return;
      clearTimeout(timer);
      timer = setTimeout(() => void now(), DEBOUNCE_MS);
    },
    now,
  };
}
