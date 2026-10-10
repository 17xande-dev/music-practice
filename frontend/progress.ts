// The progress page: reads the practice history from localStorage and shows
// a summary, an accuracy trend per scale, a per-scale table and recent
// sessions, plus export, import and clear.

import { renderAccuracyChart } from "./lib/accuracy_chart.ts";
import { better, ProgressStore, scaleKey, type Session } from "./lib/progress_store.ts";
import { betterSong, type SongSession } from "./lib/song_session.ts";
import { formatDuration, type LearnSession, summarizeLearning } from "./lib/learn_log.ts";
import { compareByCircle, scaleTitle } from "./lib/theory.ts";

import { checkStoredData } from "./lib/data_repair.ts";
import { installCommands } from "./lib/palette.ts";
import { registerServiceWorker } from "./lib/pwa.ts";
import { siteCommands } from "./lib/site_commands.ts";
import { ago, checkSignedIn, type SyncResult } from "./lib/sync.ts";
import { installSync } from "./lib/sync_triggers.ts";

registerServiceWorker();
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  warning: el("storage-warning"),
  empty: el("empty"),
  history: el("history"),
  summary: el("summary"),
  trendScale: el<HTMLSelectElement>("trend-scale"),
  trendChart: el("trend-chart"),
  scalesBody: el("scales-body"),
  recentBody: el("recent-body"),
  exportBtn: el<HTMLButtonElement>("export"),
  importInput: el<HTMLInputElement>("import"),
  clear: el<HTMLButtonElement>("clear"),
  clearConfirm: el<HTMLButtonElement>("clear-confirm"),
  status: el("data-status"),
  songHistory: el("song-history"),
  songsBody: el("songs-body"),
  songRecentBody: el("song-recent-body"),
  learning: el("learning"),
  learningBody: el("learning-body"),
  syncOut: el("sync-out"),
  syncIn: el("sync-in"),
  syncLine: el("sync-line"),
  syncNow: el<HTMLButtonElement>("sync-now"),
  offer: el("sync-offer"),
  offerText: el("sync-offer-text"),
  offerYes: el<HTMLButtonElement>("sync-offer-yes"),
  offerNo: el<HTMLButtonElement>("sync-offer-no"),
};

const store = ProgressStore.fromWindow();
const RECENT = 50;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const HANDS = { rh: "RH", lh: "LH", both: "Hands together" } as const;

function exerciseLabel(s: Session): string {
  // Guitar plays one line, so "hands" means nothing there; say guitar instead.
  const who = s.instrument === "guitar" ? "Guitar" : HANDS[s.hands];
  return `${scaleTitle(s.tonic, s.type)} · ${who} · ${s.octaves} oct${
    s.direction === "up" ? " up" : ""
  }`;
}

function cell(text: string, cls?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function tile(label: string, value: string): HTMLDivElement {
  const div = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

/**
 * Sessions grouped by scale (tonic + type), in circle-of-fifths order — the
 * same order the practice page's picker lays keys out in, so a major key sits
 * next to its relative minor. See compareByCircle.
 */
function byScale(sessions: Session[]): Session[][] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = scaleKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  return [...groups.values()].sort((a, b) => compareByCircle(a[0], b[0]));
}

function render() {
  const sessions = store.sessions();
  const songSessions = store.songSessions();
  const learnSessions = store.learnSessions();
  const any = sessions.length + songSessions.length + learnSessions.length > 0;
  ui.warning.hidden = store.available;
  ui.empty.hidden = any || !store.available;
  ui.history.hidden = sessions.length === 0;
  ui.exportBtn.disabled = !any;
  ui.clear.disabled = !any;
  renderSongs(songSessions);
  renderLearning(learnSessions);
  if (!sessions.length) return;

  const groups = byScale(sessions);
  const totalTime = sessions.reduce((a, s) => a + s.durationMs, 0);
  ui.summary.replaceChildren(
    tile("Sessions", String(sessions.length)),
    tile("Scales practised", String(groups.length)),
    tile("Time playing", minutes(totalTime)),
    tile("Last practised", day.format(sessions.at(-1)!.ts)),
  );

  // Trend: keep the chosen scale across re-renders if it still exists.
  const chosen = ui.trendScale.value;
  ui.trendScale.replaceChildren(
    ...groups.map((g) =>
      new Option(`${scaleTitle(g[0].tonic, g[0].type)} (${g.length})`, scaleKey(g[0]))
    ),
  );
  // The list is in circle order, but the chart opens on whatever was
  // practised last — that is the trend someone coming here wants to see.
  const latest = groups.reduce((a, b) => (b.at(-1)!.ts > a.at(-1)!.ts ? b : a));
  ui.trendScale.value = groups.some((g) => scaleKey(g[0]) === chosen)
    ? chosen
    : scaleKey(latest[0]);
  drawTrend(groups);

  ui.scalesBody.replaceChildren(...groups.map((g) => {
    const best = g.reduce((b, s) => (better(s, b) ? s : b));
    const tr = document.createElement("tr");
    tr.append(
      cell(scaleTitle(g[0].tonic, g[0].type)),
      cell(String(g.length), "num"),
      cell(pct(best.accuracy), "num"),
      cell(pct(g.at(-1)!.accuracy), "num"),
      cell(day.format(g.at(-1)!.ts)),
    );
    return tr;
  }));

  ui.recentBody.replaceChildren(
    ...sessions.slice(-RECENT).reverse().map((s) => {
      const tr = document.createElement("tr");
      const offset = s.timing?.meanAbsMs;
      tr.append(
        cell(when.format(s.ts)),
        cell(exerciseLabel(s)),
        cell(s.timing ? `Metronome ${s.timing.bpm} BPM` : "Notes only"),
        cell(pct(s.accuracy), "num"),
        cell(String(s.wrongNotes), "num"),
        cell(
          s.timing
            ? (offset === null || offset === undefined ? "—" : `±${Math.round(offset)} ms`)
            : `${(s.durationMs / 1000).toFixed(1)} s`,
          "num",
        ),
      );
      return tr;
    }),
  );
}

const HAND_LABEL = { both: "Both hands", rh: "RH", lh: "LH" } as const;

function songPractice(s: SongSession): string {
  const mode = s.mode === "tempo"
    ? `In time, ${s.tempoPct}%`
    : s.mode === "rubato"
    ? `Rubato, ±${s.rubatoPct ?? 25}%`
    : "Wait mode";
  return `${HAND_LABEL[s.hands]} · m. ${s.from}${s.to > s.from ? `–${s.to}` : ""} · ${mode}`;
}

/** A row of small squares, one per measure, shaded like the songs page heat map. */
function heatStrip(s: SongSession): HTMLTableCellElement {
  const td = document.createElement("td");
  const strip = document.createElement("div");
  strip.className = "heat-mini";
  for (const m of s.measures) {
    const ratio = m.steps ? m.clean / m.steps : 1;
    const cell = document.createElement("span");
    cell.className = `level-${ratio === 1 ? 4 : Math.min(3, Math.floor(ratio * 4))}`;
    cell.title = `Measure ${m.measure}: ${m.clean} of ${m.steps} clean`;
    strip.append(cell);
  }
  td.append(strip);
  return td;
}

/** Per-song bests and recent song runs. */
function renderSongs(all: SongSession[]) {
  ui.songHistory.hidden = all.length === 0;
  if (!all.length) return;
  const bySong = new Map<string, SongSession[]>();
  for (const s of all) {
    if (!bySong.has(s.songId)) bySong.set(s.songId, []);
    bySong.get(s.songId)!.push(s);
  }
  const groups = [...bySong.values()].sort((a, b) => b.at(-1)!.ts - a.at(-1)!.ts);
  ui.songsBody.replaceChildren(...groups.map((g) => {
    // Across different practices (a hard passage, the whole piece) accuracy
    // is the fair comparison; betterSong breaks ties.
    const best = g.reduce((b, s) =>
      s.accuracy > b.accuracy || (s.accuracy === b.accuracy && betterSong(s, b)) ? s : b
    );
    const tr = document.createElement("tr");
    tr.append(
      cell(g.at(-1)!.title),
      cell(String(g.length), "num"),
      cell(pct(best.accuracy), "num"),
      cell(pct(g.at(-1)!.accuracy), "num"),
      cell(day.format(g.at(-1)!.ts)),
    );
    return tr;
  }));
  ui.songRecentBody.replaceChildren(
    ...all.slice(-RECENT).reverse().map((s) => {
      const tr = document.createElement("tr");
      tr.append(
        cell(when.format(s.ts)),
        cell(s.title),
        cell(songPractice(s)),
        cell(pct(s.accuracy), "num"),
        heatStrip(s),
      );
      return tr;
    }),
  );
}

/**
 * Time spent in Learn mode, per scale and song. Kept out of everything
 * above: learning runs are never graded, so they never touch accuracy.
 */
function renderLearning(all: LearnSession[]) {
  ui.learning.hidden = all.length === 0;
  ui.learningBody.replaceChildren(
    ...summarizeLearning(all).map((l) => {
      const tr = document.createElement("tr");
      tr.append(
        cell(l.kind === "scale" && l.instrument === "guitar" ? `${l.title} · Guitar` : l.title),
        cell(l.kind === "scale" ? "Scale" : "Song"),
        cell(formatDuration(l.totalMs), "num"),
        cell(String(l.passes), "num"),
        cell(l.stumbles.length ? `m. ${l.stumbles.join(", ")}` : "—"),
        cell(day.format(l.lastTs)),
      );
      return tr;
    }),
  );
}

function drawTrend(groups = byScale(store.sessions())) {
  const g = groups.find((x) => scaleKey(x[0]) === ui.trendScale.value) ?? groups[0];
  if (g) renderAccuracyChart(ui.trendChart, g);
}

// ---- Data management --------------------------------------------------------

ui.exportBtn.addEventListener("click", () => {
  const blob = new Blob([store.exportJSON()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `music-practice-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  ui.status.textContent = `Exported ${
    store.sessions().length + store.songSessions().length + store.learnSessions().length
  } sessions.`;
});

ui.importInput.addEventListener("change", async () => {
  const file = ui.importInput.files?.[0];
  ui.importInput.value = ""; // so choosing the same file again still fires
  if (!file) return;
  try {
    const r = store.importJSON(await file.text());
    const parts = [`Imported ${r.added} session${r.added === 1 ? "" : "s"}`];
    if (r.duplicate) parts.push(`${r.duplicate} already here`);
    if (r.invalid) parts.push(`${r.invalid} unreadable and skipped`);
    ui.status.textContent = r.saved
      ? `${parts.join(", ")}.`
      : "Could not save: this browser's storage is full or blocked.";
    syncer.schedule();
  } catch (e) {
    ui.status.textContent = e instanceof Error ? e.message : "Import failed.";
  }
  render();
});

// Two steps, no dialog: the first press reveals the real button.
ui.clear.addEventListener("click", () => {
  ui.clearConfirm.hidden = false;
  ui.clearConfirm.focus();
  ui.status.textContent = store.syncState()
    ? `This clears it from your account (${
      store.syncState()!.email
    }) and your other devices too, and cannot be undone. Export first if you want a copy.`
    : "This cannot be undone. Export first if you want a copy.";
});
ui.clearConfirm.addEventListener("click", () => {
  ui.clearConfirm.hidden = true;
  ui.status.textContent = store.clear()
    ? "History cleared."
    : "Could not clear: storage is blocked.";
  render();
  void syncer.now(); // the deletions go up straight away, not after the debounce
});
ui.clearConfirm.addEventListener("blur", () => {
  setTimeout(() => (ui.clearConfirm.hidden = true), 200);
});

ui.trendScale.addEventListener("change", () => drawTrend());
let lastWidth = ui.trendChart.clientWidth;
new ResizeObserver(() => {
  if (Math.abs(ui.trendChart.clientWidth - lastWidth) > 24) {
    lastWidth = ui.trendChart.clientWidth;
    drawTrend();
  }
}).observe(ui.trendChart);

// ---- Sync ---------------------------------------------------------------------
// Signing in happens on /account (the session cookie is HttpOnly), so this page
// asks /api/me and, the first time it sees a signed-in browser, turns sync on.

let lastResult: SyncResult | null = null;

function renderSync() {
  const state = store.syncState();
  const offering = !ui.offer.hidden;
  ui.syncOut.hidden = state !== null || offering || signedIn !== "out";
  ui.syncIn.hidden = state === null;
  ui.syncNow.disabled = syncing;
  if (!state) return;
  const r = lastResult;
  ui.syncLine.replaceChildren(
    r?.status === "error"
      ? `Could not sync: ${r.message}`
      : r?.status === "offline"
      ? "Offline: your changes will sync when you are back online."
      : state.lastSyncAt
      ? `Synced with ${state.email} · ${ago(state.lastSyncAt)}`
      : `Signed in as ${state.email}`,
  );
}

let signedIn: "unknown" | "in" | "out" = "unknown";
let syncing = false;

const syncer = installSync(store, {
  onLoad: false,
  onResult(r) {
    lastResult = r;
    if (r.status === "signed-out") {
      signedIn = "out";
      ui.status.textContent = "Signed out — sign in again to sync.";
    }
    if (r.status === "ok" && r.changed) render();
    renderSync();
  },
});

async function syncNow() {
  syncing = true;
  renderSync();
  await syncer.now();
  syncing = false;
  renderSync();
}

ui.syncNow.addEventListener("click", () => void syncNow());

/** Sync is on from here: an empty cursor pulls everything, and a first push follows. */
function turnOn(email: string, queueLocal: boolean) {
  store.saveSyncState({
    email,
    cursor: 0,
    pendingAdds: queueLocal ? store.allEntries() : [],
    pendingDeletes: [],
    lastSyncAt: null,
  });
  ui.offer.hidden = true;
  void syncNow();
}

async function startSync() {
  const me = await checkSignedIn();
  const state = store.syncState();
  if (me.state === "unknown") {
    renderSync(); // offline: show what we know, the triggers retry later
    return;
  }
  if (me.state === "out") {
    signedIn = "out";
    if (state) store.clearSyncState();
    renderSync();
    return;
  }
  signedIn = "in";
  if (state && state.email === me.email) {
    void syncNow();
    return;
  }
  // First sign-in on this device (or a different account): offer to add what is here.
  const n = store.allEntries().length;
  if (n === 0) return turnOn(me.email, false);
  ui.offerText.textContent = `Add this browser's ${n} run${n === 1 ? "" : "s"} to ${me.email}?`;
  ui.offer.hidden = false;
  renderSync();
  ui.offerYes.addEventListener("click", () => turnOn(me.email, true), { once: true });
  ui.offerNo.addEventListener("click", () => turnOn(me.email, false), { once: true });
}

render();
renderSync();
if (store.available) void startSync();
void checkStoredData(store).then((deleted) => {
  if (deleted) render();
});

installCommands(siteCommands());
