// The on-screen piano: an SVG keyboard covering the exercise's range, with
// scale notes tinted, the next target(s) highlighted, and played keys shown
// green or red. State is expressed as classes; styles.css owns the colours,
// so the dark theme needs nothing here.

const SVG = "http://www.w3.org/2000/svg";
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const WHITE_W = 24;
const WHITE_H = 120;
const BLACK_W = 14;
const BLACK_H = 76;
/** Keys narrower than this on screen are too fiddly; scroll instead. */
const MIN_WHITE_PX = 18;

export const isBlack = (midi: number) => BLACK_PCS.has(((midi % 12) + 12) % 12);

export type KeyMark = "ok" | "bad" | "neutral";

export class KeyboardView {
  private svg: SVGSVGElement;
  private keys = new Map<number, SVGRectElement>();
  private lo = 60;
  private hi = 72;

  constructor(private container: HTMLElement) {
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.classList.add("piano");
    this.svg.setAttribute("role", "img");
    container.replaceChildren(this.svg);
  }

  /**
   * Draw keys from lo to hi, widened to whole octaves (C to B, or ending on
   * C when hi is a C) so the keyboard never starts or ends on a black key.
   */
  setRange(lo: number, hi: number) {
    this.lo = lo - (((lo % 12) + 12) % 12);
    this.hi = hi % 12 === 0 ? hi : hi + (11 - (hi % 12));
    this.draw();
  }

  private draw() {
    this.keys.clear();
    this.svg.replaceChildren();
    const whites: number[] = [];
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) whites.push(m);
    const width = whites.length * WHITE_W;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${WHITE_H}`);
    this.svg.setAttribute(
      "aria-label",
      `Piano keyboard, ${whites.length} white keys`,
    );
    // CSSOM, not a style attribute: the CSP forbids the latter and does not
    // govern the former.
    this.svg.style.minWidth = `${whites.length * MIN_WHITE_PX}px`;

    const whiteLayer = document.createElementNS(SVG, "g");
    const blackLayer = document.createElementNS(SVG, "g");
    const labels = document.createElementNS(SVG, "g");
    labels.classList.add("labels");
    whites.forEach((m, i) => {
      const r = this.rect(m, i * WHITE_W, 0, WHITE_W, WHITE_H, "white");
      whiteLayer.append(r);
      if (m % 12 === 0) {
        const t = document.createElementNS(SVG, "text");
        t.setAttribute("x", String(i * WHITE_W + WHITE_W / 2));
        t.setAttribute("y", String(WHITE_H - 8));
        t.textContent = `C${m / 12 - 1}`;
        labels.append(t);
      }
    });
    for (let m = this.lo; m <= this.hi; m++) {
      if (!isBlack(m)) continue;
      // A black key sits over the boundary after the white key below it.
      const leftWhite = whites.indexOf(m - 1);
      const x = (leftWhite + 1) * WHITE_W - BLACK_W / 2;
      blackLayer.append(this.rect(m, x, 0, BLACK_W, BLACK_H, "black"));
    }
    this.svg.append(whiteLayer, blackLayer, labels);
  }

  private rect(
    midi: number,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
  ): SVGRectElement {
    const r = document.createElementNS(SVG, "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", String(y));
    r.setAttribute("width", String(w));
    r.setAttribute("height", String(h));
    r.setAttribute("rx", "2");
    r.classList.add("key", color);
    r.dataset.midi = String(midi);
    this.keys.set(midi, r);
    return r;
  }

  private toggleAll(cls: string, midis: Iterable<number>) {
    const on = new Set(midis);
    for (const [m, r] of this.keys) r.classList.toggle(cls, on.has(m));
  }

  /** Faintly tint every note of the scale. */
  setScale(midis: Iterable<number>) {
    this.toggleAll("in-scale", midis);
  }

  /** Highlight what to play next. */
  setTargets(midis: Iterable<number>) {
    this.toggleAll("target", midis);
  }

  press(midi: number, mark: KeyMark) {
    const r = this.keys.get(midi);
    if (!r) return;
    r.classList.remove("ok", "bad", "neutral");
    r.classList.add("down", mark);
  }

  release(midi: number) {
    this.keys.get(midi)?.classList.remove("down", "ok", "bad", "neutral");
  }

  releaseAll() {
    for (const r of this.keys.values()) {
      r.classList.remove("down", "ok", "bad", "neutral");
    }
  }

  /** Bring a key into view inside the scrolling container. */
  reveal(midi: number) {
    const r = this.keys.get(midi);
    if (!r || this.container.scrollWidth <= this.container.clientWidth) return;
    const box = r.getBoundingClientRect();
    const view = this.container.getBoundingClientRect();
    if (box.left < view.left + 24 || box.right > view.right - 24) {
      this.container.scrollBy({
        left: box.left - view.left - view.width / 2,
        behavior: "smooth",
      });
    }
  }
}
