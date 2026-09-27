// The progress page: reads the practice history from localStorage and shows
// a summary, an accuracy trend per scale, a per-scale table and recent
// sessions, plus export, import and clear.

import { renderAccuracyChart } from "./lib/accuracy_chart.ts";
import { better, ProgressStore, scaleKey, type Session } from "./lib/progress_store.ts";
import { scaleTitle } from "./lib/theory.ts";

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
  return `${scaleTitle(s.tonic, s.type)} · ${HANDS[s.hands]} · ${s.octaves} oct${
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

/** Sessions grouped by scale (tonic + type), most recently practised first. */
function byScale(sessions: Session[]): Session[][] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = scaleKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  return [...groups.values()].sort((a, b) => b.at(-1)!.ts - a.at(-1)!.ts);
}

function render() {
  const sessions = store.sessions();
  ui.warning.hidden = store.available;
  ui.empty.hidden = sessions.length > 0 || !store.available;
  ui.history.hidden = sessions.length === 0;
  ui.exportBtn.disabled = sessions.length === 0;
  ui.clear.disabled = sessions.length === 0;
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
  if (groups.some((g) => scaleKey(g[0]) === chosen)) ui.trendScale.value = chosen;
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
  ui.status.textContent = `Exported ${store.sessions().length} sessions.`;
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
  } catch (e) {
    ui.status.textContent = e instanceof Error ? e.message : "Import failed.";
  }
  render();
});

// Two steps, no dialog: the first press reveals the real button.
ui.clear.addEventListener("click", () => {
  ui.clearConfirm.hidden = false;
  ui.clearConfirm.focus();
  ui.status.textContent = "This cannot be undone. Export first if you want a copy.";
});
ui.clearConfirm.addEventListener("click", () => {
  ui.clearConfirm.hidden = true;
  ui.status.textContent = store.clear()
    ? "History cleared."
    : "Could not clear: storage is blocked.";
  render();
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

render();
