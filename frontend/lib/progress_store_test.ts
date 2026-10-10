import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { findProblems } from "./data_repair.ts";
import type { SongLibrary } from "./song_library.ts";
import {
  exerciseKey,
  MAX_SESSIONS,
  ProgressStore,
  type Session,
  SESSIONS_KEY,
  SETTINGS_KEY,
  validSession,
  validSettings,
} from "./progress_store.ts";
import {
  betterSong,
  SONG_SESSIONS_KEY,
  type SongSession,
  validSongSession,
} from "./song_session.ts";
import { LEARN_KEY, type LearnSession, validLearnSession } from "./learn_log.ts";
import { forInput, inputOf } from "./input_source.ts";

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

Deno.test("keyboardHints is remembered, only as a boolean, and scanned", () => {
  const storage = new FakeStorage();
  const store = new ProgressStore(storage);
  store.saveSettings({ keyboardHints: false });
  assertEquals(store.settings().keyboardHints, false);
  store.saveSettings({ keyboardHints: true });
  assertEquals(store.settings().keyboardHints, true);
  storage.setItem(SETTINGS_KEY, JSON.stringify({ keyboardHints: "off" }));
  assertEquals(store.settings(), {});
  assertEquals(store.scan().some((s) => s.key === SETTINGS_KEY), true);
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

Deno.test("song view and zoom settings stay in range", () => {
  const storage = new FakeStorage();
  const store = new ProgressStore(storage);
  store.saveSettings({ songView: "line", songZoom: 1.4 });
  assertEquals(store.settings(), { songView: "line", songZoom: 1.4 });
  storage.setItem(SETTINGS_KEY, JSON.stringify({ songView: "scroll", songZoom: 9 }));
  assertEquals(store.settings(), {});
});

Deno.test("rubato song sessions and settings validate", () => {
  const store = new ProgressStore(new FakeStorage());
  const r = store.addSong(songRun({ mode: "rubato", rubatoPct: 25 }));
  assert(r.saved);
  assertEquals(store.songSessions()[0].rubatoPct, 25);
  assertEquals(validSongSession({ ...songRun({ mode: "rubato", rubatoPct: 80 }), id: "x" }), false);
  assertEquals(validSongSession({ ...songRun({ mode: "rubato", timing: null }), id: "x" }), false);
  store.saveSettings({ songMode: "rubato", songRubato: 40 });
  assertEquals(store.settings().songRubato, 40);
});

function learnRun(over: Partial<LearnSession> = {}): Omit<LearnSession, "id"> {
  return {
    ts: 1_790_000_000_000,
    kind: "song",
    subject: "song-1",
    title: "Minuet in G",
    hands: "rh",
    durationMs: 190_000,
    steps: 40,
    total: 40,
    wrongNotes: 12,
    complete: true,
    measures: [{ measure: 1, steps: 5, clean: 2 }],
    ...over,
  };
}

Deno.test("learn sessions: kept apart from the graded history", () => {
  const store = new ProgressStore(new FakeStorage());
  assert(store.addLearn(learnRun()).saved);
  assertEquals(store.learnSessions().length, 1);
  assertEquals(store.sessions(), []);
  assertEquals(store.songSessions(), []);
  assert(store.clear());
  assertEquals(store.learnSessions(), []);
});

Deno.test("learn sessions: export, import, removal with the song, hostile records", () => {
  const a = new ProgressStore(new FakeStorage());
  a.addSong(songRun());
  a.addLearn(learnRun());
  a.addLearn(
    learnRun({ kind: "scale", subject: "C0|major", title: "C major", measures: undefined }),
  );
  const b = new ProgressStore(new FakeStorage());
  assertEquals(b.importJSON(a.exportJSON()), { added: 3, duplicate: 0, invalid: 0, saved: true });
  assertEquals(b.importJSON(a.exportJSON()).duplicate, 3);
  assert(b.removeSong("song-1"));
  assertEquals(b.learnSessions().map((s) => s.subject), ["C0|major"]);

  const storage = new FakeStorage();
  storage.setItem(
    LEARN_KEY,
    JSON.stringify([
      { ...learnRun(), id: "ok", extra: "x".repeat(1000) },
      { ...learnRun(), id: "too-many-steps", steps: 41 },
      { ...learnRun(), id: "bad-kind", kind: "chord" },
    ]),
  );
  const c = new ProgressStore(storage);
  assertEquals(c.learnSessions().map((s) => s.id), ["ok"]);
  assertFalse("extra" in c.learnSessions()[0]);
});

Deno.test("learn is a valid mode on both pages", () => {
  const store = new ProgressStore(new FakeStorage());
  store.saveSettings({ mode: "learn", songMode: "learn" });
  assertEquals(store.settings().mode, "learn");
  assertEquals(store.settings().songMode, "learn");
});

Deno.test("corrupt data is skipped in memory and left alone until repair", () => {
  const fs = new FakeStorage();
  const store = new ProgressStore(fs);
  store.addSong(songRun());
  store.addSong(songRun({ ts: 1_790_000_000_005 }));
  const good = JSON.parse(fs.data.get(SONG_SESSIONS_KEY)!);
  fs.data.set(SONG_SESSIONS_KEY, JSON.stringify([...good, { nope: 1 }, "x", null]));
  fs.data.set(SESSIONS_KEY, "{not json");
  fs.data.set(LEARN_KEY, JSON.stringify({ not: "a list" }));
  fs.data.set(SETTINGS_KEY, JSON.stringify({ bpm: 9999, tonic: "C", theme: "dark", future: 1 }));
  const before = new Map(fs.data);

  assertEquals(store.songSessions().length, 2); // the page still works
  assertEquals(store.sessions(), []);
  assertEquals(store.settings(), { theme: "dark" });
  const scans = store.scan();
  assertEquals(
    scans.map((s) => [s.key, s.corrupt, s.dropped]).sort(),
    [
      [LEARN_KEY, true, 0],
      [SESSIONS_KEY, true, 0],
      [SETTINGS_KEY, false, 2], // bpm and tonic; "future" is a newer version's field
      [SONG_SESSIONS_KEY, false, 3],
    ].sort(),
  );
  assertEquals(fs.data, before); // scanning and reading change nothing
});

Deno.test("repair deletes corrupt keys and writes cleaned values back", () => {
  const fs = new FakeStorage();
  const store = new ProgressStore(fs);
  store.addSong(songRun({ input: "midi" }));
  const good = JSON.parse(fs.data.get(SONG_SESSIONS_KEY)!);
  fs.data.set(SONG_SESSIONS_KEY, JSON.stringify([...good, { nope: 1 }]));
  fs.data.set(SESSIONS_KEY, "{not json");
  fs.data.set(SETTINGS_KEY, JSON.stringify({ bpm: 9999, theme: "dark" }));
  assert(store.repair());
  assertFalse(fs.data.has(SESSIONS_KEY));
  assertEquals(JSON.parse(fs.data.get(SONG_SESSIONS_KEY)!), good);
  assertEquals(JSON.parse(fs.data.get(SETTINGS_KEY)!), { theme: "dark" });
  assertEquals(store.scan(), []);
});

Deno.test("clean or absent storage has nothing to scan, and an unavailable store never throws", () => {
  assertEquals(new ProgressStore(new FakeStorage()).scan(), []);
  const store = new ProgressStore(null);
  assertEquals(store.scan(), []);
  assertEquals(store.repair(), true);
});

Deno.test("import skips invalid records and counts them, without rejecting the file", () => {
  const src = new ProgressStore(new FakeStorage());
  src.addSong(songRun());
  const file = JSON.parse(src.exportJSON());
  file.sessions.push({ bad: true });
  file.songSessions.push(42);
  file.learnSessions = [{ bad: true }];
  const dst = new ProgressStore(new FakeStorage());
  const r = dst.importJSON(JSON.stringify(file));
  assertEquals([r.added, r.invalid], [1, 3]);
});

Deno.test("findProblems describes what's bad and only deletes when asked", async () => {
  const fs = new FakeStorage();
  fs.data.set(SESSIONS_KEY, "{not json");
  fs.data.set(SETTINGS_KEY, JSON.stringify({ bpm: 9999 }));
  const store = new ProgressStore(fs);
  const removed: string[] = [];
  const library = {
    unreadable: () => Promise.resolve([1, 2]),
    removeUnreadable: () => {
      removed.push("lib");
      return Promise.resolve();
    },
  } as unknown as SongLibrary;
  const warn = console.warn;
  console.warn = () => {};
  const { problems, remove } = await findProblems(store, library).finally(() => {
    console.warn = warn;
  });
  assertEquals(problems.map((p) => p.label), [
    "Scale practice history",
    "Settings",
    "Song library",
  ]);
  assertEquals(problems[1].detail, "1 setting can't be read and will be removed");
  // "Not now": nothing was touched.
  assertEquals(fs.data.size, 2);
  assertEquals(removed, []);
  // "Delete it".
  await remove();
  assertFalse(fs.data.has(SESSIONS_KEY));
  assertEquals(JSON.parse(fs.data.get(SETTINGS_KEY)!), {});
  assertEquals(removed, ["lib"]);
});

Deno.test("song ranges: remembered per song, validated, forgotten with the song, not exported", () => {
  const store = new ProgressStore(new FakeStorage());
  assertEquals(store.songRange("a"), undefined);
  store.setSongRange("a", { from: 9, to: 12 });
  store.setSongRange("b", { from: 2, to: 2 });
  assertEquals(store.songRange("a"), { from: 9, to: 12 });
  assertEquals(store.songRange("b"), { from: 2, to: 2 });
  store.setSongRange("a", null); // "whole piece" forgets it
  assertEquals(store.songRange("a"), undefined);
  assertEquals(store.songRange("b"), { from: 2, to: 2 });
  store.removeSong("b"); // deleting the song drops it
  assertEquals(store.songRange("b"), undefined);
  // Other settings are kept alongside.
  store.saveSettings({ songZoom: 1.2 });
  store.setSongRange("c", { from: 1, to: 4 });
  assertEquals(store.settings().songZoom, 1.2);
  assert(!store.exportJSON().includes("songRanges"));
  // Nonsense entries are dropped.
  assertEquals(
    validSettings({
      songRanges: {
        ok: { from: 1, to: 3 },
        bad: { from: 5, to: 2 },
        z: { from: 0, to: 1 },
        s: "x",
      },
    }),
    { songRanges: { ok: { from: 1, to: 3 } } },
  );
});

Deno.test("input: personal bests never cross between midi and screen", () => {
  const store = new ProgressStore(new FakeStorage());
  store.add(run({ accuracy: 0.9, input: "midi" }));
  // The first on-screen run has no previous best, however good the MIDI one was.
  assertEquals(store.add(run({ accuracy: 0.5, input: "screen" })).previousBest, null);
  assertEquals(store.add(run({ accuracy: 0.6, input: "screen" })).previousBest?.accuracy, 0.5);
  // Records from before the field are midi.
  assertEquals(store.add(run({ accuracy: 0.95 })).previousBest?.accuracy, 0.9);
  assertFalse(exerciseKey(run({ input: "screen" })) === exerciseKey(run({ input: "midi" })));
  assertEquals(exerciseKey(run()), exerciseKey(run({ input: "midi" })));

  assertEquals(
    store.addSong(songRun({ accuracy: 0.9, input: "midi" })).previousBest?.accuracy,
    undefined,
  );
  assertEquals(store.addSong(songRun({ accuracy: 0.4, input: "screen" })).previousBest, null);
  assertEquals(
    store.addSong(songRun({ accuracy: 0.5, input: "screen" })).previousBest?.accuracy,
    0.4,
  );
  assertEquals(store.addSong(songRun({ accuracy: 0.95 })).previousBest?.accuracy, 0.9);
});

Deno.test("input: validators accept the two values and reject the rest", () => {
  const scale = { ...run(), id: "a" };
  const song = { ...songRun(), id: "b" };
  const learn = { ...learnRun(), id: "c" };
  for (
    const [valid, rec] of [[validSession, scale], [validSongSession, song], [
      validLearnSession,
      learn,
    ]] as const
  ) {
    assert(valid(rec)); // no field: an older record
    assert(valid({ ...rec, input: "midi" }));
    assert(valid({ ...rec, input: "screen" }));
    assertFalse(valid({ ...rec, input: "keys" }));
    assertFalse(valid({ ...rec, input: null }));
    assertFalse(valid({ ...rec, input: 1 }));
  }
});

Deno.test("input: stored records always carry it, and old ones are read as midi", () => {
  const storage = new FakeStorage();
  const store = new ProgressStore(storage);
  store.add(run());
  store.addSong(songRun());
  store.addLearn(learnRun({ input: "screen" }));
  assertEquals(store.sessions()[0].input, "midi");
  assertEquals(store.songSessions()[0].input, "midi");
  assertEquals(store.learnSessions()[0].input, "screen");
});

Deno.test("input: importing old records (no field) keeps them as midi; new ones round-trip", () => {
  const old = new ProgressStore(new FakeStorage());
  const file = JSON.stringify({
    app: "music-practice",
    version: 1,
    exportedAt: "2026-01-01T00:00:00Z",
    sessions: [{ ...run(), id: "s-old" }, { ...run({ input: "screen" }), id: "s-new" }],
    songSessions: [{ ...songRun(), id: "g-old" }],
    learnSessions: [{ ...learnRun(), id: "l-old" }, {
      ...learnRun({ input: "bogus" as never }),
      id: "l-bad",
    }],
  });
  const r = old.importJSON(file);
  assertEquals([r.added, r.invalid], [4, 1]);
  assertEquals(old.sessions().map((s) => [s.id, inputOf(s)]), [["s-old", "midi"], [
    "s-new",
    "screen",
  ]]);
  assertEquals(old.songSessions()[0].input, "midi");
  // Export and import carry it as-is.
  const again = new ProgressStore(new FakeStorage());
  again.importJSON(old.exportJSON());
  assertEquals(again.sessions().map((s) => s.input), ["midi", "screen"]);
});

Deno.test("input: the Progress filter shows one input at a time", () => {
  const store = new ProgressStore(new FakeStorage());
  store.add(run());
  store.add(run({ input: "screen" }));
  store.addSong(songRun({ input: "screen" }));
  store.addLearn(learnRun());
  assertEquals(forInput(store.sessions(), "midi").length, 1);
  assertEquals(forInput(store.sessions(), "screen").length, 1);
  assertEquals(forInput(store.songSessions(), "midi").length, 0);
  assertEquals(forInput(store.songSessions(), "screen").length, 1);
  assertEquals(forInput(store.learnSessions(), "midi").length, 1);
  assertEquals(forInput(store.learnSessions(), "screen").length, 0);
});

Deno.test("input: the Progress setting is validated and remembered", () => {
  const store = new ProgressStore(new FakeStorage());
  assertEquals(store.settings().progressInput, undefined); // the page defaults to midi
  store.saveSettings({ progressInput: "screen" });
  assertEquals(store.settings().progressInput, "screen");
  assertEquals(validSettings({ progressInput: "nope" }), {});
});
