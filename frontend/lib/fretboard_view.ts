// The guitar's counterpart to the on-screen piano: an SVG fretboard with the
// chosen position shaded, the exercise's notes as dots where the box puts
// them, the next target highlighted, and played notes shown green or red.
// Same methods as KeyboardView, so the practice page swaps one for the
// other without branching at every call.
//
// Tab orientation: high e on top, low E at the bottom, nut on the left.
// Frets are spaced as on a real neck (each 2^(-1/12) of the one before), so
// a box looks the size it feels. Colours are classes; styles.css owns them.

import { type Box, type FretPosition, MAX_FRET, placesFor, STANDARD_TUNING } from "./guitar.ts";
import type { KeyMark } from "./keyboard_view.ts";

const SVG = "http://www.w3.org/2000/svg";
const W = 1000;
const H = 200;
const LEFT = 34; // room for open-string dots left of the nut
const RIGHT = 12;
const TOP = 22;
const STRING_GAP = 28;
const INLAYS = [3, 5, 7, 9, 15];
const STRING_NAMES = ["E", "A", "D", "G", "B", "e"];

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** x of fret wire `f` (0 = the nut), with real-neck spacing. */
function fretX(f: number): number {
  const span = 1 - 2 ** (-MAX_FRET / 12);
  return LEFT + ((W - LEFT - RIGHT) * (1 - 2 ** (-f / 12))) / span;
}

/** Where a note on fret f is fingered: between wires f−1 and f; open strings left of the nut. */
function noteX(f: number): number {
  return f === 0 ? LEFT / 2 : (fretX(f - 1) + fretX(f)) / 2;
}

/** y of string s (0 = low E, drawn at the bottom). */
const stringY = (s: number) => TOP + (5 - s) * STRING_GAP;

export class FretboardView {
  private svg: SVGSVGElement;
  private boxRect: SVGRectElement;
  private dotLayer: SVGGElement;
  private playedLayer: SVGGElement;
  private dots = new Map<number, SVGGElement>();
  private played = new Map<number, SVGGElement>();
  private box: Box | null = null;

  constructor(private container: HTMLElement) {
    this.svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "fretboard", role: "img" });
    this.svg.setAttribute("aria-label", "Guitar fretboard");
    const board = el("rect", {
      class: "board",
      x: LEFT,
      y: TOP - 8,
      width: W - LEFT - RIGHT,
      height: 5 * STRING_GAP + 16,
      rx: 3,
    });
    this.boxRect = el("rect", { class: "box", y: TOP - 8, height: 5 * STRING_GAP + 16, rx: 3 });
    this.svg.append(board, this.boxRect);

    const midY = TOP + 2.5 * STRING_GAP;
    for (const f of INLAYS) {
      const x = noteX(f);
      this.svg.append(el("circle", { class: "inlay", cx: x, cy: midY, r: 6 }));
    }
    for (const dy of [-1, 1]) {
      this.svg.append(
        el("circle", { class: "inlay", cx: noteX(12), cy: midY + dy * STRING_GAP, r: 6 }),
      );
    }
    for (let f = 0; f <= MAX_FRET; f++) {
      this.svg.append(el("line", {
        class: f === 0 ? "nut" : "fret",
        x1: fretX(f),
        x2: fretX(f),
        y1: TOP - 8,
        y2: TOP + 5 * STRING_GAP + 8,
      }));
      if (f > 0) {
        const n = el("text", { class: "fret-number", x: noteX(f), y: H - 6 });
        n.textContent = String(f);
        this.svg.append(n);
      }
    }
    for (let s = 0; s < 6; s++) {
      this.svg.append(el("line", {
        class: "string",
        x1: LEFT,
        x2: W - RIGHT,
        y1: stringY(s),
        y2: stringY(s),
        "stroke-width": 1 + (5 - s) * 0.35,
      }));
      const label = el("text", { class: "string-name", x: 6, y: stringY(s) });
      label.textContent = STRING_NAMES[s];
      this.svg.append(label);
    }
    this.dotLayer = el("g");
    this.playedLayer = el("g");
    this.svg.append(this.dotLayer, this.playedLayer);
    container.replaceChildren(this.svg);
  }

  /**
   * Shade `box` and draw a dot for every note of the exercise where `layout`
   * puts it, labelled with its spelled name, or with the finger that plays
   * it when the page shows fingering.
   */
  setLayout(box: Box, layout: Map<number, FretPosition>, names: Map<number, string>) {
    this.box = box;
    const x0 = box.position === 0 ? 0 : fretX(box.lo - 1);
    const x1 = fretX(box.hi);
    this.boxRect.setAttribute("x", String(x0));
    this.boxRect.setAttribute("width", String(x1 - x0));
    this.dots.clear();
    this.dotLayer.replaceChildren();
    for (const [midi, p] of layout) {
      const g = this.dot(p, names.get(midi) ?? "");
      g.classList.add("scale");
      if (!p.inBox) g.classList.add("outside");
      this.dots.set(midi, g);
      this.dotLayer.append(g);
    }
    this.releaseAll();
  }

  private dot(p: FretPosition, label: string): SVGGElement {
    const g = el("g", { class: "dot" });
    g.append(el("circle", { cx: noteX(p.fret), cy: stringY(p.string), r: 11 }));
    const t = el("text", { x: noteX(p.fret), y: stringY(p.string) });
    t.textContent = label;
    g.append(t);
    return g;
  }

  /** Relabel the dots (note names or finger numbers) without redrawing. */
  setLabels(labels: Map<number, string>) {
    for (const [m, g] of this.dots) {
      const t = g.querySelector("text");
      if (t) t.textContent = labels.get(m) ?? "";
    }
  }

  /** The exercise's notes are always shown; kept for KeyboardView parity. */
  setScale(_midis: Iterable<number>) {}

  /** The dots already carry the fingers, so `fingers` is for parity only. */
  setTargets(midis: Iterable<number>, _fingers?: readonly (number | null)[]) {
    const on = new Set(midis);
    for (const [m, g] of this.dots) g.classList.toggle("target", on.has(m));
  }

  /**
   * Show a played note: on its dot if it belongs to the exercise, otherwise
   * at the place nearest the box (a wrong note has no dot of its own).
   */
  press(midi: number, mark: KeyMark) {
    this.release(midi);
    const own = this.dots.get(midi);
    if (own) {
      own.classList.add("down", mark);
      return;
    }
    const place = this.nearestPlace(midi);
    if (!place) return;
    const g = this.dot(place, "");
    g.classList.add("played", "down", mark);
    this.played.set(midi, g);
    this.playedLayer.append(g);
  }

  release(midi: number) {
    this.dots.get(midi)?.classList.remove("down", "ok", "bad", "neutral");
    this.played.get(midi)?.remove();
    this.played.delete(midi);
  }

  releaseAll() {
    for (const g of this.dots.values()) g.classList.remove("down", "ok", "bad", "neutral");
    this.playedLayer.replaceChildren();
    this.played.clear();
  }

  /** Bring a note into view when the fretboard scrolls (narrow screens). */
  reveal(midi: number) {
    const g = this.dots.get(midi);
    if (!g || this.container.scrollWidth <= this.container.clientWidth) return;
    const box = g.getBoundingClientRect();
    const view = this.container.getBoundingClientRect();
    if (box.left < view.left + 24 || box.right > view.right - 24) {
      this.container.scrollBy({ left: box.left - view.left - view.width / 2, behavior: "smooth" });
    }
  }

  private nearestPlace(midi: number): FretPosition | null {
    const places = placesFor(midi, STANDARD_TUNING);
    if (!places.length || !this.box) return places[0] ?? null;
    const b = this.box;
    const dist = (p: FretPosition) => p.fret < b.lo ? b.lo - p.fret : Math.max(0, p.fret - b.hi);
    return places.reduce((best, p) => (dist(p) < dist(best) ? p : best));
  }
}
