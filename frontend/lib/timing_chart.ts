// The tempo-mode results chart: one dot per note, placed by how far from the
// click it landed (late above the line, early below), with the on-the-beat
// tolerance as a shaded band. Missed notes are an × on the line. Colour
// repeats what position already says, so it is never the only cue.

import type { TimingSummary } from "./engine.ts";
import { noteLabel, type Step } from "./theory.ts";

const SVG = "http://www.w3.org/2000/svg";
const H = 170;
const PAD = { left: 84, right: 12, top: 14, bottom: 14 };

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export type DotKind = "on" | "early" | "late" | "missed";

/**
 * The y-range, in ms either side of the beat: wide enough for the worst
 * note and three tolerances, but never wider than half the gap between
 * notes, which is as far off as a note can be and still count.
 */
export function chartRange(t: TimingSummary, intervalMs: number): number {
  const worst = Math.max(0, ...t.deviations.map((d) => (d === null ? 0 : Math.abs(d))));
  return Math.min(intervalMs / 2, Math.max(t.toleranceMs * 3, worst * 1.1));
}

export function renderTimingChart(
  container: HTMLElement,
  steps: readonly Step[],
  t: TimingSummary,
  intervalMs: number,
) {
  const range = chartRange(t, intervalMs);
  // Drawn at the container's real width rather than scaled from a fixed
  // viewBox, so dots and labels keep their size at every width.
  const W = Math.max(280, container.clientWidth || 640);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (ms: number) =>
    PAD.top + plotH / 2 - (Math.max(-range, Math.min(range, ms)) / range) * (plotH / 2);
  const x = (i: number) =>
    PAD.left + (steps.length === 1 ? plotW / 2 : (i / (steps.length - 1)) * plotW);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label":
      `Timing of each note against the click: ${t.onTime} on the beat, ${t.early} early, ${t.late} late, ${t.missed} missed`,
  });
  svg.classList.add("timing-plot");

  // Tolerance band and the beat line.
  svg.append(
    svgEl("rect", {
      class: "band",
      x: PAD.left,
      y: y(t.toleranceMs),
      width: plotW,
      height: y(-t.toleranceMs) - y(t.toleranceMs),
    }),
    svgEl("line", { class: "beat", x1: PAD.left, x2: W - PAD.right, y1: y(0), y2: y(0) }),
  );
  const label = (text: string, yy: number) => {
    const e = svgEl("text", {
      class: "axis",
      x: PAD.left - 8,
      y: yy,
      "dominant-baseline": "middle",
    });
    e.textContent = text;
    return e;
  };
  svg.append(
    label(`${Math.round(range)} ms late`, PAD.top + 4),
    label("on beat", y(0)),
    label(`${Math.round(range)} ms early`, H - PAD.bottom - 4),
  );

  t.deviations.forEach((d, i) => {
    const step = steps[i];
    const name = step.notes.map((n) => noteLabel(n.spelled)).join(" + ");
    const g = svgEl("g", { class: "dot" });
    const title = svgEl("title", {});
    if (d === null) {
      g.classList.add("missed");
      const cx = x(i);
      const cy = y(0);
      g.append(
        svgEl("path", {
          d: `M${cx - 4} ${cy - 4}L${cx + 4} ${cy + 4}M${cx + 4} ${cy - 4}L${cx - 4} ${cy + 4}`,
        }),
        // A larger invisible target, so the tooltip is easy to hit.
        svgEl("circle", { class: "hit", cx, cy, r: 9 }),
      );
      title.textContent = `Note ${i + 1} (${name}): missed`;
    } else {
      const kind: DotKind = Math.abs(d) <= t.toleranceMs ? "on" : d < 0 ? "early" : "late";
      g.classList.add(kind);
      g.append(
        svgEl("circle", { cx: x(i), cy: y(d), r: 4.5 }),
        svgEl("circle", { class: "hit", cx: x(i), cy: y(d), r: 9 }),
      );
      const ms = Math.round(Math.abs(d));
      title.textContent = `Note ${i + 1} (${name}): ${
        ms === 0 ? "on the beat" : `${ms} ms ${d < 0 ? "early" : "late"}`
      }`;
    }
    g.prepend(title);
    svg.append(g);
  });

  const legend = document.createElement("ul");
  legend.className = "timing-legend";
  for (
    const [kind, text] of [
      ["on", `On the beat (±${Math.round(t.toleranceMs)} ms)`],
      ["early", "Early"],
      ["late", "Late"],
      ["missed", "Missed"],
    ]
  ) {
    const li = document.createElement("li");
    li.className = kind;
    li.textContent = text;
    legend.append(li);
  }
  container.replaceChildren(svg, legend);
}
