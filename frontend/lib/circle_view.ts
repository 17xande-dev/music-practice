// The key picker: a circle of fifths drawn as SVG. Major keys on the outer
// ring, their relative minors on the inner ring, C major / A minor at the
// top and one more sharp per step clockwise. Tapping a name picks that tonic
// and ring; the enharmonic wedges (F♯/G♭ and friends) show both spellings,
// each its own target.
//
// Built once and updated in place: re-creating the SVG on every selection
// would drop keyboard focus mid-navigation. Colours are classes; styles.css
// owns them, so the dark theme needs nothing here, and nothing sets a style
// attribute (the CSP refuses those).

import {
  circleOfFifths,
  type Family,
  keySignatureFifths,
  nameOf,
  neighbourhood,
  pitchClass,
  type PitchName,
  signatureLong,
  signatureShort,
  wedgeOf,
} from "./theory.ts";

const SVG = "http://www.w3.org/2000/svg";
const C = 200; // centre of the 400×400 viewBox
// Numerals live just outside each ring (a rim beyond the outer ring, a band
// inside the inner one), so they never collide with names or signatures.
const R_OUTER = 184;
const R_RING = 128; // boundary between the major and minor rings
const R_INNER = 80; // inside edge of the minor ring; the centre text sits within

export interface CircleSelection {
  tonic: PitchName;
  ring: Family;
}

interface Target {
  ring: Family;
  wedge: number;
  pitch: PitchName;
  g: SVGGElement;
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Point at radius r and angle a (degrees, 0 = top, clockwise). */
function pt(r: number, a: number): [number, number] {
  const t = (a * Math.PI) / 180;
  return [C + r * Math.sin(t), C - r * Math.cos(t)];
}

/** An annular sector between radii r0 < r1 and angles a0 < a1. */
function sector(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = pt(r1, a0);
  const [x1, y1] = pt(r1, a1);
  const [x2, y2] = pt(r0, a1);
  const [x3, y3] = pt(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`;
}

const fifthsWord = (p: PitchName, ring: Family) =>
  signatureLong(keySignatureFifths(p, ring === "major" ? "major" : "natural-minor")!);

export class CircleView {
  onSelect: (s: CircleSelection) => void = () => {};

  private svg: SVGSVGElement;
  private targets: Target[] = [];
  private numerals = new Map<string, SVGTextElement>(); // `${ring}${wedge}`
  private centreTitle: SVGTextElement;
  private centreSig: SVGTextElement;
  private selected: Target | null = null;

  constructor(container: HTMLElement) {
    this.svg = el("svg", { viewBox: "0 0 400 400", class: "cof", role: "radiogroup" });
    this.svg.setAttribute("aria-label", "Circle of fifths: choose a key");
    const wedges = circleOfFifths();
    for (const w of wedges) {
      this.drawWedge("major", w.index, w.major, R_RING, R_OUTER);
      this.drawWedge("minor", w.index, w.minor, R_INNER, R_RING);
    }
    this.centreTitle = el("text", { x: C, y: C - 6, class: "centre-title" });
    this.centreSig = el("text", { x: C, y: C + 18, class: "centre-sig" });
    this.svg.append(this.centreTitle, this.centreSig);
    this.svg.addEventListener("keydown", (e) => this.key(e));
    container.replaceChildren(this.svg);
  }

  private drawWedge(ring: Family, wedge: number, spellings: PitchName[], r0: number, r1: number) {
    const a0 = wedge * 30 - 15;
    const a1 = wedge * 30 + 15;
    const mid = wedge * 30;
    const outer = ring === "major";
    // One spelling fills the wedge; two split it into an outer and an inner
    // half so each is a comfortable tap target of its own.
    const bands = spellings.length === 1 ? [[r0, r1]] : [[(r0 + r1) / 2, r1], [r0, (r0 + r1) / 2]];
    spellings.forEach((pitch, i) => {
      const [b0, b1] = bands[i];
      const g = el("g", { class: `target ${ring}`, role: "radio", tabindex: -1 });
      g.setAttribute(
        "aria-label",
        `${nameOf(pitch)} ${outer ? "major" : "minor"}, ${fifthsWord(pitch, ring)}`,
      );
      g.append(el("path", { d: sector(b0, b1, a0, a1) }));
      const split = spellings.length > 1;
      const rLabel = (b0 + b1) / 2 + (outer && !split ? 6 : 0);
      const [lx, ly] = pt(rLabel, mid);
      const label = el("text", {
        x: lx,
        y: ly,
        class: `name${split ? " small" : ""}`,
      });
      label.textContent = nameOf(pitch) + (outer ? "" : "m");
      g.append(label);
      // The outer ring also shows its key signature, so sharps visibly grow
      // clockwise and flats counter-clockwise. Under the name on a full
      // wedge; beside it on a split one, where there is no room below.
      if (outer) {
        const sig = signatureShort(keySignatureFifths(pitch, "major")!);
        if (sig && split) {
          const t = el("tspan", { class: "sig", dx: 4 });
          t.textContent = sig;
          label.append(t);
        } else if (sig) {
          const [sx, sy] = pt(rLabel - 20, mid);
          const t = el("text", { x: sx, y: sy, class: "sig" });
          t.textContent = sig;
          g.append(t);
        }
      }
      g.addEventListener("click", () => this.pick({ ring, wedge, pitch, g }));
      this.svg.append(g);
      this.targets.push({ ring, wedge, pitch, g });
    });
    // A numeral slot per wedge and ring, filled for the selected key's
    // neighbours (I IV V ii iii vi, or i iv v III VI VII), placed outside
    // the ring it labels: beyond the outer rim, or inside the inner edge.
    const [nx, ny] = pt(outer ? r1 + 9 : r0 - 8, mid);
    const n = el("text", { x: nx, y: ny, class: "numeral" });
    this.numerals.set(`${ring}${wedge}`, n);
    this.svg.append(n);
  }

  private pick(t: Target) {
    this.onSelect({ tonic: t.pitch, ring: t.ring });
  }

  /**
   * Show `tonic` as selected on `ring`, with `title` in the centre. The tonic
   * may be a spelling the ring does not print (a saved D♭ Dorian sits on the
   * C♯m wedge); its wedge is highlighted all the same.
   */
  render(tonic: PitchName, ring: Family, title: string, fifths: number | null) {
    const wedge = wedgeOf(tonic, ring);
    const onWedge = this.targets.filter((t) => t.ring === ring && t.wedge === wedge);
    this.selected =
      onWedge.find((t) => t.pitch.letter === tonic.letter && t.pitch.acc === tonic.acc) ??
        onWedge.find((t) => pitchClass(t.pitch) === pitchClass(tonic)) ?? onWedge[0];

    const near = neighbourhood(wedge, ring);
    const nearKey = new Set(near.map((n) => `${n.ring}${n.index}`));
    for (const t of this.targets) {
      const on = t === this.selected;
      t.g.classList.toggle("selected", on);
      t.g.classList.toggle("near", !on && nearKey.has(`${t.ring}${t.wedge}`));
      t.g.setAttribute("aria-checked", String(on));
      t.g.setAttribute("tabindex", on ? "0" : "-1");
    }
    for (const text of this.numerals.values()) text.textContent = "";
    for (const n of near) {
      const text = this.numerals.get(`${n.ring}${n.index}`);
      if (text) text.textContent = n.numeral;
    }
    this.centreTitle.textContent = title;
    this.centreSig.textContent = fifths === null ? "no key signature" : signatureLong(fifths);
  }

  /**
   * Arrow keys, radio-group style: Left/Right step around the ring (split
   * wedges are two stops), Up/Down switch rings at the same wedge. Moving
   * selects, as radio groups do.
   */
  private key(e: KeyboardEvent) {
    const cur = this.selected;
    if (!cur) return;
    let next: Target | undefined;
    const ringTargets = this.targets.filter((t) => t.ring === cur.ring);
    const i = ringTargets.indexOf(cur);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const step = e.key === "ArrowRight" ? 1 : -1;
      next = ringTargets[(i + step + ringTargets.length) % ringTargets.length];
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const ring: Family = cur.ring === "major" ? "minor" : "major";
      next = this.targets.find((t) => t.ring === ring && t.wedge === cur.wedge);
    } else if (e.key === "Enter" || e.key === " ") {
      next = cur;
    }
    if (!next) return;
    e.preventDefault();
    this.pick(next);
    // render() moves tabindex; focus follows the new selection.
    this.selected?.g.focus();
  }
}
