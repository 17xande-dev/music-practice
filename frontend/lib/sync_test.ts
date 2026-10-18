import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  MAX_SESSIONS,
  ProgressStore,
  SESSIONS_KEY,
  type SyncState,
  validId,
} from "./progress_store.ts";
import { SONG_SESSIONS_KEY } from "./song_session.ts";
import { ago, BATCH, checkSignedIn, type FetchFn, MAX_BODY_BYTES, sync } from "./sync.ts";

class MemStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

let clock = 1_700_000_000_000;
const scale = (over = {}) => ({
  ts: clock++,
  tonic: { letter: "D" as const, acc: 0 as const },
  type: "major" as const,
  hands: "rh" as const,
  octaves: 2,
  direction: "updown" as const,
  mode: "notes" as const,
  total: 29,
  correct: 27,
  accuracy: 27 / 29,
  wrongNotes: 2,
  durationMs: 14000,
  unevenness: null,
  velocityStd: null,
  notTogether: 0,
  timing: null,
  ...over,
});
const song = (over = {}) => ({
  ts: clock++,
  songId: "song-1",
  title: "Minuet in G",
  hands: "rh" as const,
  from: 1,
  to: 8,
  mode: "tempo" as const,
  tempoPct: 80,
  total: 40,
  correct: 36,
  accuracy: 0.9,
  wrongNotes: 3,
  durationMs: 20000,
  timing: { onTime: 30, early: 3, late: 3, missed: 4, meanAbsMs: 25, meanSignedMs: 4 },
  measures: [{ measure: 1, steps: 5, clean: 5 }],
  ...over,
});
const learn = (over = {}) => ({
  ts: clock++,
  kind: "song" as const,
  subject: "song-1",
  title: "Minuet in G",
  hands: "rh" as const,
  durationMs: 190_000,
  steps: 40,
  total: 40,
  wrongNotes: 12,
  complete: true,
  ...over,
});

function syncedStore(over: Partial<SyncState> = {}) {
  const storage = new MemStorage();
  const store = new ProgressStore(storage);
  assert(store.saveSyncState({
    email: "a@example.com",
    cursor: 0,
    pendingAdds: [],
    pendingDeletes: [],
    lastSyncAt: null,
    ...over,
  }));
  return store;
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

Deno.test("sync off: nothing is queued and no state appears", () => {
  const store = new ProgressStore(new MemStorage());
  store.add(scale());
  store.removeSong("x");
  store.clear();
  assertEquals(store.syncState(), null);
});

Deno.test("add, addSong and addLearn queue their runs", () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  const b = store.addSong(song()).session;
  const c = store.addLearn(learn()).session;
  assertEquals(store.syncState()!.pendingAdds, [
    { kind: "scale", id: a.id },
    { kind: "song", id: b.id },
    { kind: "learn", id: c.id },
  ]);
});

Deno.test("import queues only the runs it added", () => {
  const src = new ProgressStore(new MemStorage());
  src.add(scale());
  src.addSong(song());
  const file = src.exportJSON();
  const store = syncedStore();
  const r = store.importJSON(file);
  assertEquals(r.added, 2);
  assertEquals(store.syncState()!.pendingAdds.length, 2);
  store.updateSync((s) => s.pendingAdds = []);
  const again = store.importJSON(file);
  assertEquals([again.added, again.duplicate], [0, 2]);
  assertEquals(store.syncState()!.pendingAdds, []);
});

Deno.test("removeSong queues the ids actually removed and drops their pending adds", () => {
  const store = syncedStore();
  const s1 = store.addSong(song()).session;
  const other = store.addSong(song({ songId: "song-2" })).session;
  const l1 = store.addLearn(learn()).session;
  store.addLearn(learn({ subject: "song-2" }));
  store.removeSong("song-1");
  const st = store.syncState()!;
  assertEquals(
    st.pendingDeletes.map((e) => e.id).sort(),
    [s1.id, l1.id].sort(),
  );
  assertEquals(st.pendingAdds.map((e) => e.id).includes(s1.id), false);
  assert(st.pendingAdds.some((e) => e.id === other.id));
});

Deno.test("clear queues every removed run as a deletion", () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  const b = store.addSong(song()).session;
  store.clear();
  const st = store.syncState()!;
  assertEquals(st.pendingAdds, []);
  assertEquals(
    st.pendingDeletes,
    [{ kind: "scale", id: a.id }, { kind: "song", id: b.id }],
  );
});

Deno.test("the cap trim never queues a deletion", () => {
  const store = syncedStore();
  const many = Array.from(
    { length: MAX_SESSIONS },
    (_, i) => ({ ...scale({ ts: i + 1 }), id: `s${i}` }),
  );
  localStorageSet(store, SESSIONS_KEY, many);
  store.add(scale({ ts: 10_000_000 }));
  assertEquals(store.sessions().length, MAX_SESSIONS);
  assertEquals(store.syncState()!.pendingDeletes, []);
  // Merging pulled runs past the cap trims quietly too.
  store.mergeRecords("scale", [{ ...scale({ ts: 20_000_000 }), id: "new" }]);
  assertEquals(store.syncState()!.pendingDeletes, []);
  assertEquals(store.sessions().length, MAX_SESSIONS);
});

function localStorageSet(store: ProgressStore, key: string, v: unknown) {
  // deno-lint-ignore no-explicit-any
  (store as any).storage.setItem(key, JSON.stringify(v));
}

Deno.test("mergeRecords is idempotent, sorted, and drops invalid records", () => {
  const store = new ProgressStore(new MemStorage());
  const recs = [{ ...scale({ ts: 30 }), id: "b" }, { ...scale({ ts: 10 }), id: "a" }, {
    id: "bad",
  }];
  const first = store.mergeRecords("scale", recs);
  assertEquals([first.addedIds.length, first.invalid], [2, 1]);
  const second = store.mergeRecords("scale", recs);
  assertEquals([second.addedIds.length, second.duplicate], [0, 2]);
  assertEquals(ids(store.sessions()), ["a", "b"]);
});

Deno.test("removeIds reports only what was there", () => {
  const store = new ProgressStore(new MemStorage());
  store.mergeRecords("song", [{ ...song(), id: "x" }]);
  assertEquals(store.removeIds("song", ["x", "nope"]), ["x"]);
  assertEquals(store.removeIds("song", ["x"]), []);
  assertEquals(store.songSessions(), []);
});

// ---- the sync loop --------------------------------------------------------

interface Call {
  account?: string;
  cursor: number;
  push: Record<string, { id: string }[]>;
  deleted: { kind: string; id: string }[];
}

/** A fake /api/sync: each handler answers one call in order. */
function fakeServer(...replies: ((c: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const f: FetchFn = async (url, init) => {
    assertEquals(url, "/api/sync");
    const c = JSON.parse(init!.body as string) as Call;
    calls.push(c);
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error("unexpected call");
    return await reply(c);
  };
  return { f, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const answer = (over: Record<string, unknown> = {}) => ({
  cursor: 1,
  records: { scale: [], song: [], learn: [] },
  deleted: [],
  more: false,
  rejected: [],
  ...over,
});

Deno.test("sync pushes pending runs and clears the queue", async () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  store.addSong(song());
  store.removeSong("song-1");
  const srv = fakeServer((c) => {
    assertEquals(c.push.scale.map((r) => r.id), [a.id]);
    assertEquals(c.push.song, []); // queued then deleted: never sent as an add
    assertEquals(c.deleted.length, 1);
    return json(answer({ cursor: 7, records: { scale: [c.push.scale[0]], song: [], learn: [] } }));
  });
  const r = await sync(store, srv.f);
  assertEquals(r, { status: "ok", changed: false });
  const st = store.syncState()!;
  assertEquals([st.cursor, st.pendingAdds, st.pendingDeletes], [7, [], []]);
  assert(st.lastSyncAt !== null);
});

Deno.test("sync pages while more is true, then merges everything", async () => {
  const store = syncedStore();
  const rec = (id: string, ts: number) => ({ ...scale({ ts }), id });
  const srv = fakeServer(
    () => json(answer({ cursor: 2, more: true, records: { scale: [rec("a", 20)] } })),
    (c) => {
      assertEquals(c.cursor, 2);
      return json(
        answer({ cursor: 3, records: { scale: [rec("b", 10)], song: [{ ...song(), id: "s" }] } }),
      );
    },
  );
  const r = await sync(store, srv.f);
  assertEquals(r, { status: "ok", changed: true });
  assertEquals(ids(store.sessions()), ["b", "a"]);
  assertEquals(ids(store.songSessions()), ["s"]);
  assertEquals(store.syncState()!.cursor, 3);
});

Deno.test("sync sends at most BATCH runs per request and keeps going", async () => {
  const store = syncedStore();
  const all = Array.from(
    { length: BATCH + 20 },
    (_, i) => ({ ...scale({ ts: i + 1 }), id: `r${i}` }),
  );
  store.mergeRecords("scale", all);
  store.queueAdds(all.map((r) => ({ kind: "scale" as const, id: r.id })));
  const srv = fakeServer(
    (c) => {
      assertEquals(c.push.scale.length, BATCH);
      return json(answer({ cursor: 1 }));
    },
    (c) => {
      assertEquals(c.push.scale.length, 20);
      return json(answer({ cursor: 2 }));
    },
  );
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(srv.calls.length, 2);
  assertEquals(store.syncState()!.pendingAdds, []);
});

Deno.test("runs queued while a request is in flight survive it", async () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  let late = "";
  const srv = fakeServer(
    (c) => {
      late = store.add(scale()).session.id; // recorded mid-request
      return json(answer({ cursor: 1, records: { scale: [c.push.scale[0]] } }));
    },
    (c) => {
      assertEquals(c.push.scale.map((r) => r.id), [late]);
      return json(answer({ cursor: 2 }));
    },
  );
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(srv.calls.length, 2);
  assertEquals(store.syncState()!.pendingAdds, []);
  assertEquals(ids(store.sessions()).includes(a.id), true);
});

Deno.test("a run deleted while its push was in flight is not resurrected", async () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  const srv = fakeServer(
    (c) => {
      store.removeIds("scale", [a.id]);
      store.queueDeletes([{ kind: "scale", id: a.id }]);
      return json(answer({ cursor: 1, records: { scale: [c.push.scale[0]] } }));
    },
    (c) => {
      assertEquals(c.deleted, [{ kind: "scale", id: a.id }]);
      return json(answer({ cursor: 2 }));
    },
  );
  await sync(store, srv.f);
  assertEquals(store.sessions(), []);
  assertEquals(store.syncState()!.pendingDeletes, []);
});

Deno.test("rejected runs leave the queue", async () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  const srv = fakeServer(() =>
    json(answer({ rejected: [{ kind: "scale", id: a.id, reason: "nope" }] }))
  );
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(store.syncState()!.pendingAdds, []);
});

Deno.test("a rejection without an id still empties the queue (no resend loop)", async () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  const srv = fakeServer(
    () => json(answer({ rejected: [{ kind: "scale", reason: "record over 65536 bytes" }] })),
  );
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(store.syncState()!.pendingAdds, []);
  assertEquals(srv.calls.length, 1);
  assertEquals(srv.calls[0].push.scale.map((r) => r.id), [a.id]);
});

Deno.test("a round that leaves the sent entries queued and pulls nothing is an error", async () => {
  const store = syncedStore();
  store.add(scale());
  // A store that loses the queue update, as a full or failing storage would.
  store.updateSync = () => {};
  const srv = fakeServer(() => json(answer({ cursor: 0 })), () => json(answer({ cursor: 0 })));
  const r = await sync(store, srv.f);
  assertEquals(r.status, "error");
  assertEquals(srv.calls.length, 1);
});

Deno.test("validId counts UTF-8 bytes the way the server does", () => {
  assert(validId("a".repeat(64)));
  assertFalse(validId("a".repeat(65)));
  assertFalse(validId(""));
  assertFalse(validId(5));
  assert(validId("\u20ac".repeat(21))); // 63 bytes
  assertFalse(validId("\u20ac".repeat(22))); // 22 UTF-16 units but 66 bytes
});

Deno.test("pending adds whose runs are gone are dropped, not retried forever", async () => {
  const store = syncedStore({ pendingAdds: [{ kind: "scale", id: "ghost" }] });
  const srv = fakeServer(() => json(answer()));
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(store.syncState()!.pendingAdds, []);
});

Deno.test("tombstones delete local runs and their pending adds", async () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  const b = store.addSong(song()).session;
  const srv = fakeServer((c) =>
    json(answer({
      cursor: 4,
      records: { scale: [c.push.scale[0]], song: [] },
      deleted: [{ kind: "song", id: b.id }],
    }))
  );
  const r = await sync(store, srv.f);
  assertEquals(r, { status: "ok", changed: true });
  assertEquals(ids(store.sessions()), [a.id]);
  assertEquals(store.songSessions(), []);
  assertEquals(store.syncState()!.pendingAdds, []);
});

Deno.test("401 turns sync off and keeps the history", async () => {
  const store = syncedStore();
  store.add(scale());
  const srv = fakeServer(() => json({ error: "sign in" }, 401));
  assertEquals(await sync(store, srv.f), { status: "signed-out" });
  assertEquals(store.syncState(), null);
  assertEquals(store.sessions().length, 1);
  assertEquals(await sync(store, srv.f), { status: "off" });
});

Deno.test("a network error or 5xx keeps everything pending", async () => {
  const store = syncedStore();
  const a = store.add(scale()).session;
  store.queueDeletes([{ kind: "song", id: "gone" }]);
  const down: FetchFn = () => Promise.reject(new TypeError("offline"));
  assertEquals(await sync(store, down), { status: "offline" });
  const srv = fakeServer(() => json({ error: "boom" }, 500));
  assertEquals((await sync(store, srv.f)).status, "error");
  const st = store.syncState()!;
  assertEquals(st.pendingAdds, [{ kind: "scale", id: a.id }]);
  assertEquals(st.pendingDeletes, [{ kind: "song", id: "gone" }]);
});

Deno.test("two syncs at once share one request", async () => {
  const store = syncedStore();
  store.add(scale());
  const srv = fakeServer(() => json(answer()));
  const [x, y] = await Promise.all([sync(store, srv.f), sync(store, srv.f)]);
  assertEquals(x, y);
  assertEquals(srv.calls.length, 1);
});

Deno.test("checkSignedIn reads /api/me", async () => {
  assertEquals(await checkSignedIn(() => Promise.resolve(json({ email: "a@b.c" }))), {
    state: "in",
    email: "a@b.c",
  });
  assertEquals(await checkSignedIn(() => Promise.resolve(json({}, 401))), { state: "out" });
  assertEquals(await checkSignedIn(() => Promise.reject(new TypeError("x"))), {
    state: "unknown",
  });
});

Deno.test("ago words", () => {
  const now = 1_000_000_000_000;
  assertEquals(ago(now - 10_000, now), "just now");
  assertEquals(ago(now - 120_000, now), "2 min ago");
  assertEquals(ago(now - 3 * 3_600_000, now), "3 h ago");
  assertFalse(ago(now - 3 * 86_400_000, now).includes("ago"));
});

Deno.test("sync state survives only when well formed", () => {
  const storage = new MemStorage();
  const store = new ProgressStore(storage);
  storage.setItem("mp.v1.sync", "{not json");
  assertEquals(store.syncState(), null);
  storage.setItem(SONG_SESSIONS_KEY, "[]");
  storage.setItem(
    "mp.v1.sync",
    JSON.stringify({ email: "a@b.c", cursor: 3, pendingAdds: [{ kind: "x", id: "1" }] }),
  );
  assertEquals(store.syncState()!.pendingAdds, []);
});

Deno.test("every request names the account it believes it syncs with", async () => {
  const store = syncedStore();
  store.add(scale());
  const srv = fakeServer((c) => {
    assertEquals(c.account, "a@example.com");
    return json(answer());
  });
  assertEquals((await sync(store, srv.f)).status, "ok");
});

Deno.test("409 account mismatch turns sync off, keeps history, sends nothing more", async () => {
  const store = syncedStore({ cursor: 9 });
  store.add(scale());
  const srv = fakeServer(() => json({ error: "account mismatch" }, 409));
  assertEquals(await sync(store, srv.f), { status: "account-mismatch" });
  assertEquals(store.syncState(), null);
  assertEquals(store.sessions().length, 1);
  assertEquals(await sync(store, srv.f), { status: "off" });
  assertEquals(srv.calls.length, 1);
});

Deno.test("a sync-state change made by another tab discards the response", async () => {
  const store = syncedStore({ cursor: 5 });
  store.add(scale());
  const srv = fakeServer(() => {
    // Another tab signed in as someone else: localStorage is shared, so the
    // stored state changes under this tab's feet.
    assert(store.saveSyncState({
      email: "b@example.com",
      cursor: 0,
      pendingAdds: [],
      pendingDeletes: [],
      lastSyncAt: null,
    }));
    return json(answer({ cursor: 99, records: { scale: [{ ...scale(), id: "stale" }] } }));
  });
  assertEquals(await sync(store, srv.f), { status: "off" });
  assertEquals(store.syncState()!.email, "b@example.com");
  assertEquals(store.syncState()!.cursor, 0);
  assertFalse(ids(store.sessions()).includes("stale"));
});

Deno.test("a sign-out in another tab discards the response", async () => {
  const store = syncedStore();
  store.add(scale());
  const srv = fakeServer(() => {
    store.clearSyncState();
    return json(answer({ cursor: 3, records: { scale: [{ ...scale(), id: "stale" }] } }));
  });
  assertEquals(await sync(store, srv.f), { status: "off" });
  assertFalse(ids(store.sessions()).includes("stale"));
});

/** A store whose runs are big, so byte caps can be tested without a 4 MB history. */
function bigStore(n: number, bytes: number) {
  const store = syncedStore();
  const runs = Array.from(
    { length: n },
    (_, i) => ({ id: `r${i}`, ts: i + 1, pad: "x".repeat(bytes) }),
  );
  store.list = () => runs;
  store.queueAdds(runs.map((r) => ({ kind: "scale" as const, id: r.id })));
  return store;
}

Deno.test("batches are capped by JSON bytes as well as by count", async () => {
  const store = bigStore(5, 1 << 20); // ~1 MB each: only three fit under 4 MB
  const sizes: number[] = [];
  const reply = (c: Call) => {
    sizes.push(c.push.scale.length);
    return json(answer({ cursor: sizes.length }));
  };
  const srv = fakeServer(reply, reply);
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(sizes, [3, 2]);
  assertEquals(MAX_BODY_BYTES, 4 << 20);
});

Deno.test("a 413 halves the batch and retries", async () => {
  const store = bigStore(8, 10);
  const sizes: number[] = [];
  const tooBig = (c: Call) => {
    sizes.push(c.push.scale.length);
    return json({ error: "too large" }, 413);
  };
  const ok = (c: Call) => {
    sizes.push(c.push.scale.length);
    return json(answer({ cursor: sizes.length }));
  };
  const srv = fakeServer(tooBig, tooBig, ok, ok, ok, ok);
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(sizes, [8, 4, 2, 2, 2, 2]);
  assertEquals(store.syncState()!.pendingAdds, []);
});

Deno.test("a 413 for a single run is an error, not a loop", async () => {
  const store = bigStore(1, 10);
  const srv = fakeServer(() => json({ error: "too large" }, 413));
  assertEquals((await sync(store, srv.f)).status, "error");
  assertEquals(store.syncState()!.pendingAdds.length, 1);
});

Deno.test("a round that neither shrinks the queue nor pulls anything stops with an error", async () => {
  const store = syncedStore();
  let calls = 0;
  const f: FetchFn = () => {
    calls++;
    return Promise.resolve(json(answer({ cursor: 0, more: true })));
  };
  assertEquals((await sync(store, f)).status, "error");
  assertEquals(calls, 1);
});

Deno.test("runs and records without a positive ts are not valid", () => {
  const store = syncedStore();
  const bad = [{ ...scale(), id: "z", ts: 0 }, { ...scale(), id: "n", ts: -5 }];
  assertEquals(store.mergeRecords("scale", bad).invalid, 2);
});
