import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  exerciseKey,
  MAX_SESSIONS,
  ProgressStore,
  type Session,
  SESSIONS_KEY,
  SETTINGS_KEY,
  validSession,
} from "./progress_store.ts";
import {
  betterSong,
  SONG_SESSIONS_KEY,
  type SongSession,
  validSongSession,
} from "./song_session.ts";

/** An in-memory Storage, optionally refusing writes (a full quota). */
class FakeStorage implements Storage {
  data = new Map<string, string>();
  failWrites = false;
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
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
    this.data.set(k, v);
  }
}

/** Storage that throws on every access, as in some private windows. */
class ThrowingStorage extends FakeStorage {
  override getItem(): string | null {
    throw new DOMException("denied", "SecurityError");
  }
  override setItem(): void {
    throw new DOMException("denied", "SecurityError");
  }
}

let clock = 1_700_000_000_000;
function run(over: Partial<Session> = {}): Omit<Session, "id"> {
  return {
    ts: clock++,
    tonic: { letter: "D", acc: 0 },
    type: "major",
    hands: "rh",
    octaves: 2,
    direction: "updown",
    mode: "notes",
    total: 29,
    correct: 27,
    accuracy: 27 / 29,
    wrongNotes: 2,
    durationMs: 14000,
    unevenness: 0.1,
    velocityStd: 8,
    notTogether: 0,
    timing: null,
    ...over,
  };
}

Deno.test("sessions round-trip, oldest first", () => {
  const store = new ProgressStore(new FakeStorage());
  assert(store.available);
  const a = store.add(run({ ts: 2000 }));
  const b = store.add(run({ ts: 1000 }));
  assert(a.saved && b.saved);
  assertEquals(store.sessions().map((s) => s.ts), [1000, 2000]);
  assert(a.session.id !== b.session.id);
});

Deno.test("previous best is reported for the same exercise only", () => {
  const store = new ProgressStore(new FakeStorage());
  assertEquals(store.add(run({ accuracy: 0.8 })).previousBest, null);
  store.add(run({ accuracy: 0.9 }));
  store.add(run({ accuracy: 1, octaves: 1 })); // different exercise
  const r = store.add(run({ accuracy: 0.95 }));
  assertEquals(r.previousBest?.accuracy, 0.9);
});

Deno.test("exercise key separates tempo from notes-only", () => {
  assertFalse(exerciseKey(run()) === exerciseKey(run({ mode: "tempo" })));
});

Deno.test("history is capped, dropping the oldest", () => {
  const storage = new FakeStorage();
  const many = Array.from(
    { length: MAX_SESSIONS },
    (_, i) => ({ ...run({ ts: i + 1 }), id: `s${i}` }),
  );
  storage.setItem(SESSIONS_KEY, JSON.stringify(many));
  const store = new ProgressStore(storage);
  store.add(run({ ts: 10_000_000 }));
  const all = store.sessions();
  assertEquals(all.length, MAX_SESSIONS);
  assertEquals(all[0].id, "s1");
});

// Practice must keep working when history cannot be kept.
Deno.test("unavailable or throwing storage degrades, never throws", () => {
  for (const store of [new ProgressStore(null), new ProgressStore(new ThrowingStorage())]) {
    assertFalse(store.available);
    assertEquals(store.sessions(), []);
    assertFalse(store.add(run()).saved);
    assertEquals(store.settings(), {});
    store.saveSettings({ bpm: 90 });
  }
});

Deno.test("a full quota reports not saved", () => {
  const storage = new FakeStorage();
  const store = new ProgressStore(storage);
  storage.failWrites = true;
  assertFalse(store.add(run()).saved);
});

Deno.test("corrupt or foreign data reads as empty; invalid records are dropped", () => {
  const storage = new FakeStorage();
  storage.setItem(SESSIONS_KEY, "{not json");
  assertEquals(new ProgressStore(storage).sessions(), []);
  storage.setItem(
    SESSIONS_KEY,
    JSON.stringify([{ ...run(), id: "ok" }, { id: "bad", accuracy: 7 }, null]),
  );
  assertEquals(new ProgressStore(storage).sessions().map((s) => s.id), ["ok"]);
});

Deno.test("settings keep valid fields and drop the rest", () => {
  const storage = new FakeStorage();
  const store = new ProgressStore(storage);
  store.saveSettings({ bpm: 96, octaves: 3, device: "Digital Piano" });
  store.saveSettings({ bpm: 999 as number, mode: "tempo" });
  assertEquals(store.settings(), { bpm: 96, octaves: 3, device: "Digital Piano", mode: "tempo" });
  storage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ type: "not-a-scale", hands: "both", tonic: { letter: "H", acc: 0 } }),
  );
  assertEquals(store.settings(), { hands: "both" });
});

Deno.test("the fingering switch is remembered, and only as a boolean", () => {
  const storage = new FakeStorage();
  const store = new ProgressStore(storage);
  store.saveSettings({ fingering: true });
  assertEquals(store.settings().fingering, true);
  store.saveSettings({ fingering: false });
  assertEquals(store.settings().fingering, false);
  storage.setItem(SETTINGS_KEY, JSON.stringify({ fingering: "yes" }));
  assertEquals(store.settings(), {});
});

Deno.test("export then import into a fresh store restores everything; re-import adds nothing", () => {
  const a = new ProgressStore(new FakeStorage());
  a.add(run());
  a.add(run({
    mode: "tempo",
    timing: {
      bpm: 80,
      notesPerBeat: 2,
      onTime: 20,
      early: 3,
      late: 4,
      missed: 2,
      meanAbsMs: 31,
      meanSignedMs: 5,
    },
  }));
  const file = a.exportJSON(new Date("2026-09-27T12:00:00Z"));
  assertEquals(JSON.parse(file).version, 1);

  const b = new ProgressStore(new FakeStorage());
  assertEquals(b.importJSON(file), { added: 2, duplicate: 0, invalid: 0, saved: true });
  assertEquals(b.sessions(), a.sessions());
  assertEquals(b.importJSON(file), { added: 0, duplicate: 2, invalid: 0, saved: true });
});

Deno.test("import refuses what is not an export, and drops invalid or padded records", () => {
  const store = new ProgressStore(new FakeStorage());
  assertThrows(() => store.importJSON("nope"), Error, "not valid JSON");
  assertThrows(() => store.importJSON('{"sessions": []}'), Error, "not a Music Practice export");
  assertThrows(
    () => store.importJSON(JSON.stringify({ app: "music-practice", version: 99, sessions: [] })),
    Error,
    "newer version",
  );
  const padded = { ...run(), id: "x", extra: "y".repeat(1000) };
  const file = JSON.stringify({
    app: "music-practice",
    version: 1,
    sessions: [padded, { id: "junk" }],
  });
  assertEquals(store.importJSON(file), { added: 1, duplicate: 0, invalid: 1, saved: true });
  assertFalse("extra" in store.sessions()[0]);
});

Deno.test("validSession: tempo runs carry timing, notes-only runs do not", () => {
  assert(validSession({ ...run(), id: "a" }));
  assertFalse(validSession({ ...run({ mode: "tempo" }), id: "a" }));
  assertFalse(validSession({ ...run(), id: "a", correct: 30 })); // more correct than total
});

Deno.test("guitar fields: optional on sessions, validated in settings, separate bests", () => {
  // Sessions from before guitar support have no instrument and still load.
  assert(validSession({ ...run(), id: "old" }));
  assert(validSession({ ...run(), id: "g", instrument: "guitar" }));
  assertFalse(validSession({ ...run(), id: "x", instrument: "banjo" }));
  // A guitar best never shadows the piano best for the same scale, and the
  // piano key is unchanged from before.
  assertFalse(exerciseKey(run()) === exerciseKey(run({ instrument: "guitar" })));
  assertEquals(exerciseKey(run()), exerciseKey(run({ instrument: "piano" })));
  const store = new ProgressStore(new FakeStorage());
  store.saveSettings({
    instrument: "guitar",
    position: 5,
    audioDevice: "Rocksmith USB Guitar Adapter",
  });
  store.saveSettings({ position: 40 as number }); // out of range: dropped
  assertEquals(store.settings(), {
    instrument: "guitar",
    position: 5,
    audioDevice: "Rocksmith USB Guitar Adapter",
  });
  const g = store.add(run({ instrument: "guitar" }));
  assertEquals(store.sessions().find((s) => s.id === g.session.id)?.instrument, "guitar");
});

function songRun(over: Partial<SongSession> = {}): Omit<SongSession, "id"> {
  return {
    ts: 1_790_000_000_000,
    songId: "song-1",
    title: "Minuet in G",
    hands: "rh",
    from: 1,
    to: 8,
    mode: "tempo",
    tempoPct: 80,
    total: 40,
    correct: 36,
    accuracy: 0.9,
    wrongNotes: 3,
    durationMs: 20000,
    timing: { onTime: 30, early: 3, late: 3, missed: 4, meanAbsMs: 25, meanSignedMs: 4 },
    measures: [{ measure: 1, steps: 5, clean: 5 }, { measure: 2, steps: 5, clean: 3 }],
    ...over,
  };
}

Deno.test("song sessions: stored apart from scales, with bests per practice", () => {
  const store = new ProgressStore(new FakeStorage());
  const first = store.addSong(songRun());
  assert(first.saved);
  assertEquals(first.previousBest, null);
  const second = store.addSong(songRun({ accuracy: 0.95, correct: 38, tempoPct: 90 }));
  assertEquals(second.previousBest?.id, first.session.id);
  // A different range is a different practice.
  assertEquals(store.addSong(songRun({ from: 9, to: 16 })).previousBest, null);
  assertEquals(store.songSessions().length, 3);
  assertEquals(store.sessions(), []);
  assert(betterSong(second.session, first.session));
});

Deno.test("song sessions: export, import and removal", () => {
  const a = new ProgressStore(new FakeStorage());
  a.add(run());
  a.addSong(songRun());
  const b = new ProgressStore(new FakeStorage());
  assertEquals(b.importJSON(a.exportJSON()), { added: 2, duplicate: 0, invalid: 0, saved: true });
  assertEquals(b.importJSON(a.exportJSON()).duplicate, 2);
  assertEquals(b.songSessions()[0].title, "Minuet in G");
  assert(b.removeSong("song-1"));
  assertEquals(b.songSessions(), []);
  assertEquals(b.sessions().length, 1);
});

Deno.test("song sessions: hostile records are dropped and rebuilt clean", () => {
  const storage = new FakeStorage();
  storage.setItem(
    SONG_SESSIONS_KEY,
    JSON.stringify([
      { ...songRun(), id: "ok", extra: "x".repeat(1000) },
      { ...songRun(), id: "bad-range", from: 5, to: 2 },
      { ...songRun(), id: "bad-timing", mode: "notes" },
      { ...songRun(), id: "bad-measure", measures: [{ measure: 1, steps: 1, clean: 2 }] },
    ]),
  );
  const got = new ProgressStore(storage).songSessions();
  assertEquals(got.map((s) => s.id), ["ok"]);
  assertEquals("extra" in got[0], false);
  assertEquals(validSongSession({ ...songRun(), id: "x", tempoPct: 500 }), false);
});

Deno.test("songs page settings are validated like the rest", () => {
  const storage = new FakeStorage();
  const store = new ProgressStore(storage);
  store.saveSettings({ songMode: "listen", songTempo: 75, songLoop: true, lastSong: "abc" });
  assertEquals(store.settings(), {
    songMode: "listen",
    songTempo: 75,
    songLoop: true,
    lastSong: "abc",
  });
  storage.setItem(SETTINGS_KEY, JSON.stringify({ songMode: "karaoke", songTempo: 5, songLoop: 1 }));
  assertEquals(store.settings(), {});
});
