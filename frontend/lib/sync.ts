// Progress sync with the server: the client side of docs/sync-api.md.
//
// Local history stays the source of truth and works signed out. While sync
// is on (mp.v1.sync exists) the store queues new runs and deletions, and
// `sync()` swaps them with the server and pulls what other devices did.
// Signing in itself happens on the server-rendered /account page: the
// session cookie is HttpOnly, so this code can only ask /api/me whether it
// is there.

import { entryKey, type Kind, type ProgressStore, type SyncEntry } from "./progress_store.ts";

/** Runs sent per request; the server caps a body at 16 MB. */
export const BATCH = 500;
/** A backstop against a loop that cannot make progress (storage refusing writes). */
const MAX_ROUNDS = 200;
const KINDS: Kind[] = ["scale", "song", "learn"];

export type SyncResult =
  | { status: "ok"; changed: boolean }
  /** Sync is not on here: nothing was done. */
  | { status: "off" }
  /** The server said 401; sync is now off and local history is untouched. */
  | { status: "signed-out" }
  /** The network failed; everything stays queued for the next trigger. */
  | { status: "offline" }
  | { status: "error"; message: string };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (input, init) => globalThis.fetch(input, init);

let running: Promise<SyncResult> | null = null;

/**
 * Sync now. Two syncs never overlap: a call while one is running gets that
 * one's result (it also picks up anything queued meanwhile, see `round`).
 */
export function sync(store: ProgressStore, f: FetchFn = defaultFetch): Promise<SyncResult> {
  running ??= rounds(store, f).finally(() => running = null);
  return running;
}

async function rounds(store: ProgressStore, f: FetchFn): Promise<SyncResult> {
  let changed = false;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const r = await round(store, f);
    if (r.status !== "ok") return r;
    changed ||= r.changed;
    // Done once the server has nothing more and nothing is waiting to go up,
    // including what was queued while the request was in flight.
    const s = store.syncState();
    if (!s) return { status: "off" };
    if (!r.more && !s.pendingAdds.length && !s.pendingDeletes.length) {
      return { status: "ok", changed };
    }
    if (r.more && !r.progress) return { status: "error", message: "The server's reply stalled." };
  }
  return { status: "error", message: "Sync could not finish." };
}

type Round =
  | { status: "ok"; changed: boolean; more: boolean; progress: boolean }
  | Exclude<
    SyncResult,
    { status: "ok" }
  >;

const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

async function round(store: ProgressStore, f: FetchFn): Promise<Round> {
  const state = store.syncState();
  if (!state) return { status: "off" };

  // Look each queued run up locally; ones that are gone (trimmed by the cap,
  // or deleted) have nothing to send but still leave the queue.
  const batch = state.pendingAdds.slice(0, BATCH);
  const deletes = state.pendingDeletes.slice();
  const push: Record<Kind, unknown[]> = { scale: [], song: [], learn: [] };
  const local = new Map<Kind, Map<string, unknown>>();
  for (const e of batch) {
    if (!local.has(e.kind)) local.set(e.kind, new Map(store.list(e.kind).map((r) => [r.id, r])));
    const rec = local.get(e.kind)!.get(e.id);
    if (rec) push[e.kind].push(rec);
  }

  let res: Response;
  try {
    res = await f("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursor: state.cursor, push, deleted: deletes }),
    });
  } catch {
    return { status: "offline" };
  }
  if (res.status === 401) {
    store.clearSyncState();
    return { status: "signed-out" };
  }
  let body: Record<string, unknown>;
  try {
    body = await res.json();
  } catch {
    return { status: "error", message: `The server sent an unreadable reply (${res.status}).` };
  }
  if (!res.ok) {
    const msg = typeof body?.error === "string" ? body.error : `The server said ${res.status}.`;
    return { status: "error", message: msg };
  }

  // Drop exactly what was sent (and what the server refused); entries queued
  // while the request was in flight stay.
  const sent = new Set(batch.map(entryKey));
  for (const r of arr(body.rejected)) {
    const e = r as Partial<SyncEntry>;
    if (typeof e?.id === "string") sent.add(entryKey(e as SyncEntry));
  }
  const sentDeletes = new Set(deletes.map(entryKey));
  store.updateSync((s) => {
    s.pendingAdds = s.pendingAdds.filter((e) => !sent.has(entryKey(e)));
    s.pendingDeletes = s.pendingDeletes.filter((e) => !sentDeletes.has(entryKey(e)));
  });

  // Merge what came back. A run deleted here since the request went out is
  // not welcomed back; its deletion is still queued and will reach the server.
  let changed = false;
  const waiting = new Set((store.syncState()?.pendingDeletes ?? []).map(entryKey));
  const records = (body.records ?? {}) as Record<string, unknown>;
  for (const kind of KINDS) {
    const wanted = arr(records[kind]).filter((r) =>
      !waiting.has(entryKey({ kind, id: String((r as { id?: unknown })?.id) }))
    );
    if (store.mergeRecords(kind, wanted).addedIds.length) changed = true;
  }

  // Tombstones: other devices deleted these.
  const dead = arr(body.deleted).filter((d): d is SyncEntry =>
    typeof (d as SyncEntry)?.id === "string" && KINDS.includes((d as SyncEntry).kind)
  );
  for (const kind of KINDS) {
    const ids = dead.filter((d) => d.kind === kind).map((d) => d.id);
    if (ids.length && store.removeIds(kind, ids).length) changed = true;
  }
  const deadKeys = new Set(dead.map(entryKey));
  const cursor = typeof body.cursor === "number" ? body.cursor : state.cursor;
  store.updateSync((s) => {
    s.pendingAdds = s.pendingAdds.filter((e) => !deadKeys.has(entryKey(e)));
    s.cursor = cursor;
    s.lastSyncAt = Date.now();
  });

  return {
    status: "ok",
    changed,
    more: body.more === true,
    progress: cursor !== state.cursor || batch.length > 0 || deletes.length > 0,
  };
}

export type SignedIn = { state: "in"; email: string } | { state: "out" } | { state: "unknown" };

/** Ask the server whether this browser's session cookie is good. */
export async function checkSignedIn(f: FetchFn = defaultFetch): Promise<SignedIn> {
  try {
    const res = await f("/api/me");
    if (res.status === 401) return { state: "out" };
    if (!res.ok) return { state: "unknown" };
    const body = await res.json();
    return typeof body?.email === "string" ? { state: "in", email: body.email } : {
      state: "unknown",
    };
  } catch {
    return { state: "unknown" }; // offline: say nothing rather than guess
  }
}

/** "just now", "2 min ago", "3 h ago", or the date. */
export function ago(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" });
}
