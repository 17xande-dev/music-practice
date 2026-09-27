// Accuracy over time for one scale: one line across its sessions in order,
// with a marker per session. The two grading modes differ in shape
// (filled for notes-only, a ring for tempo), not colour, since it is one
// series. Each marker has a tooltip.

import type { Session } from "./progress_store.ts";

const SVG = "http://www.w3.org/2000/svg";
const H = 200;
const PAD = { left: 44, right: 16, top: 12, bottom: 28 };

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function describe(s: Session): string {
  const mode = s.timing ? `tempo ${s.timing.bpm} BPM` : "notes only";
  return `${fullFmt.format(s.ts)}: ${
    Math.round(s.accuracy * 100)
  }% (${mode}, ${s.hands.toUpperCase()}, ${s.octaves} oct)`;
}

export function renderAccuracyChart(container: HTMLElement, sessions: readonly Session[]) {
  const W = Math.max(280, container.clientWidth || 640);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (sessions.length === 1 ? plotW / 2 : (i / (sessions.length - 1)) * plotW);
  const y = (acc: number) => PAD.top + (1 - acc) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `Accuracy across ${sessions.length} sessions, latest ${
      Math.round((sessions.at(-1)?.accuracy ?? 0) * 100)
    }%`,
  });
  svg.classList.add("trend-plot");

  for (const v of [0, 0.5, 1]) {
    svg.append(
      svgEl("line", { class: "grid", x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v) }),
    );
    const t = svgEl("text", {
      class: "axis",
      x: PAD.left - 6,
      y: y(v),
      "dominant-baseline": "middle",
      "text-anchor": "end",
    });
    t.textContent = `${v * 100}%`;
    svg.append(t);
  }
  if (sessions.length) {
    const first = svgEl("text", {
      class: "axis",
      x: x(0),
      y: H - 8,
      "text-anchor": sessions.length === 1 ? "middle" : "start",
    });
    first.textContent = dateFmt.format(sessions[0].ts);
    svg.append(first);
    if (sessions.length > 1) {
      const last = svgEl("text", {
        class: "axis",
        x: x(sessions.length - 1),
        y: H - 8,
        "text-anchor": "end",
      });
      last.textContent = dateFmt.format(sessions[sessions.length - 1].ts);
      svg.append(last);
    }
  }
  if (sessions.length > 1) {
    svg.append(svgEl("polyline", {
      class: "line",
      points: sessions.map((s, i) => `${x(i)},${y(s.accuracy)}`).join(" "),
    }));
  }
  sessions.forEach((s, i) => {
    const g = svgEl("g", { class: `mark ${s.timing ? "tempo" : "notes"}` });
    const title = svgEl("title", {});
    title.textContent = describe(s);
    g.append(
      title,
      svgEl("circle", { cx: x(i), cy: y(s.accuracy), r: 4.5 }),
      svgEl("circle", { class: "hit", cx: x(i), cy: y(s.accuracy), r: 10 }),
    );
    svg.append(g);
  });

  const legend = document.createElement("ul");
  legend.className = "trend-legend";
  for (const [cls, text] of [["notes", "Notes only"], ["tempo", "With metronome"]]) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    legend.append(li);
  }
  container.replaceChildren(svg, legend);
}
