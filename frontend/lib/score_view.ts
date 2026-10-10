// The rendered score on the songs page, drawn by OpenSheetMusicDisplay.
//
// OSMD lays out and draws the MusicXML; this wrapper walks its cursor once
// to hand the piece over as plain RawEntry records (score.ts takes it from
// there), and marks notes by class on their SVG groups, as the scales staff
// does, so marking never needs a re-render.
//
// OSMD's own cursor is never shown: it is an <img> with a data: URL, which
// the CSP's img-src refuses. This view draws the same thing as a <div>: a
// soft vertical band over the current step, spanning its system, placed
// with OSMD's own geometry (Cursor.update, default type). The notes of the
// current step also get the "current" class.

import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { RawEntry } from "./score.ts";
import {
  LONG_PRESS_MS,
  measureAt,
  type MeasureBox,
  outsideRange,
  spanBetween,
  stillHolding,
} from "./measure_select.ts";
import { walkCursor } from "./score_walk.ts";
import type { StepMark } from "./staff_view.ts";

/** Where the cursor band goes for a note, in px within the score. */
interface Spot {
  x: number;
  top: number;
  height: number;
}

/** OSMD's graphical model, as far as the cursor needs it. */
interface OsmdBox {
  AbsolutePosition: { x: number; y: number };
  RelativePosition: { x: number; y: number };
}
interface OsmdSystem {
  PositionAndShape: OsmdBox;
  StaffLines: { PositionAndShape: OsmdBox; StaffHeight: number }[];
}
interface OsmdMeasure {
  PositionAndShape: OsmdBox & { BorderLeft: number; BorderRight: number };
  ParentStaffLine?: { PositionAndShape: OsmdBox; StaffHeight: number };
}
interface OsmdGNote {
  getSVGGElement?(): SVGGElement;
  parentVoiceEntry?: {
    parentStaffEntry?: {
      PositionAndShape: OsmdBox;
      parentMeasure?: { ParentMusicSystem?: OsmdSystem };
    };
  };
}
/**
 * In the continuous view, how far across the box the cursor is held:
 * near the left, so most of the box shows the notes coming up.
 */
const LINE_ANCHOR = 0.2;
/** OSMD lays out in units of 10 px at zoom 1. */
const UNIT = 10;

const MARKS: StepMark[] = ["current", "ok", "bad", "early", "late"];

export interface SongInfo {
  title: string;
  composer: string;
}

export class ScoreView {
  private osmd: OpenSheetMusicDisplay;
  /** SVG group of each RawNote.ref, rebuilt after every render. */
  private elements: (SVGGElement | null)[] = [];
  private spots: (Spot | null)[] = [];
  private page: HTMLElement;
  private cursor: HTMLDivElement;
  private cursorRefs: readonly number[] | null = null;
  private line = false;
  private gliding = false;
  private marks = new Map<number, StepMark>();
  /** Heat level (0-4) to tint each measure with, by 0-based measure index. */
  private heat = new Map<number, number>();
  private loaded = false;
  private lastWidth = 0;
  /** Called after a re-render (resize, theme), when refs point at new elements. */
  onRender: () => void = () => {};
  /** A click on the score: the note nearest the click (a RawNote.ref). */
  onSeek: (ref: number) => void = () => {};
  /** A press-hold-drag over measures was released: 1-based, from <= to. */
  onSelectRange: (from: number, to: number) => void = () => {};
  /** The measure range being dragged, 0-based and inclusive, while selecting. */
  private sel: { from: number; to: number } | null = null;
  private selecting: {
    anchor: number;
    pointer: number;
    x: number;
    y: number;
    start: { x: number; y: number };
    timer: number;
    scroller: number;
    active: boolean;
  } | null = null;
  private swallowClick = false;
  /** 0-based measures faded as outside the practice range. */
  private dimmed: number[] = [];

  constructor(private readonly container: HTMLElement) {
    // OSMD sizes the score to its element's outer width; an inner element
    // takes the scrolling box's content width, so nothing overflows sideways.
    const page = document.createElement("div");
    page.className = "score-page";
    container.replaceChildren(page);
    this.page = page;
    this.cursor = document.createElement("div");
    this.cursor.className = "score-cursor";
    this.cursor.setAttribute("aria-hidden", "true");
    this.cursor.hidden = true;
    this.wireSelect(page);
    page.addEventListener("click", (e) => {
      if (this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      const ref = this.refAt(e.clientX, e.clientY);
      if (ref !== null) this.onSeek(ref);
    });
    this.osmd = new OpenSheetMusicDisplay(page, {
      backend: "svg",
      autoResize: false, // resized below, so marks can be put back
      followCursor: false,
      drawTitle: false, // the page shows the title above the score
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
    });
    this.osmd.EngravingRules.RenderFingerings = false;
    new ResizeObserver(() => {
      const w = container.clientWidth;
      if (this.loaded && Math.abs(w - this.lastWidth) > 24) this.render();
    }).observe(container);
  }

  /**
   * Load and draw a score: MusicXML text, or a zipped .mxl, which OSMD
   * unzips itself when given the bytes as a binary string. Throws with a
   * readable message if the file can't be read as music.
   */
  async load(data: ArrayBuffer, format: "musicxml" | "mxl"): Promise<SongInfo> {
    const bytes = new Uint8Array(data);
    let content: string;
    if (format === "mxl") {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      content = bin;
    } else {
      content = new TextDecoder().decode(bytes);
    }
    this.loaded = false;
    this.marks.clear();
    this.heat.clear();
    this.dimmed = [];
    try {
      await this.osmd.load(content);
    } catch (e) {
      throw new Error(
        `This file couldn't be read as a score${e instanceof Error ? ` (${e.message})` : ""}.`,
      );
    }
    this.loaded = true;
    this.render();
    const sheet = this.osmd.Sheet;
    return { title: sheet.TitleString?.trim() ?? "", composer: sheet.ComposerString?.trim() ?? "" };
  }

  /** Show or hide the fingering printed in the file. */
  setFingering(show: boolean) {
    // Set on the engraving rules: OSMD's drawFingerings option can switch
    // fingerings off but never back on (2.1.3).
    this.osmd.EngravingRules.RenderFingerings = show;
    if (this.loaded) this.render();
  }

  private render() {
    this.lastWidth = this.container.clientWidth;
    // currentColor: the sheet's colour is CSS (site theme or the sheet's own
    // light/dark switch), so switching needs no re-render.
    this.osmd.setOptions({ defaultColorMusic: "currentColor" });
    this.osmd.render();
    const svg = this.container.querySelector("svg");
    svg?.setAttribute("role", "img");
    svg?.setAttribute("aria-label", "The score");
    // The walk is cheap next to layout, and it is what maps refs to the
    // freshly drawn elements.
    this.walk();
    for (const [ref, m] of this.marks) this.apply(ref, m);
    this.drawHeat();
    this.drawSelection();
    this.drawDim();
    // OSMD replaces the page's contents when it renders.
    this.page.append(this.cursor);
    if (this.cursorRefs) this.showCursor(this.cursorRefs);
    this.onRender();
  }

  /**
   * Walk the cursor through the piece, repeats played out (see walkCursor).
   * Also refreshes the ref → SVG element table, so it runs after every render.
   */
  walk(): RawEntry[] {
    const rules = this.osmd.EngravingRules;
    this.elements = [];
    this.spots = [];
    // A note played in each pass of a repeat is one note on the page, so it
    // gets one ref: a tap on it can then find every pass (stepOfRef).
    const known = new Map<unknown, number>();
    return walkCursor(this.osmd, (raw) => {
      const seen = known.get(raw);
      if (seen !== undefined) return seen;
      let el: SVGGElement | null = null;
      let spot: Spot | null = null;
      try {
        const g = rules.GNote(raw as never) as unknown as OsmdGNote | undefined;
        el = g?.getSVGGElement?.() ?? null;
        spot = this.spotOf(g);
      } catch {
        el = null;
      }
      this.elements.push(el);
      this.spots.push(spot);
      known.set(raw, this.elements.length - 1);
      return this.elements.length - 1;
    });
  }

  /** OSMD's cursor geometry for a note: its staff entry's x, its system's height. */
  private spotOf(g: OsmdGNote | undefined): Spot | null {
    const entry = g?.parentVoiceEntry?.parentStaffEntry;
    const system = entry?.parentMeasure?.ParentMusicSystem;
    if (!entry || !system?.StaffLines.length) return null;
    const zoom = UNIT * this.osmd.Zoom;
    const sy = system.PositionAndShape.AbsolutePosition.y;
    const first = system.StaffLines[0];
    const last = system.StaffLines[system.StaffLines.length - 1];
    const top = sy + first.PositionAndShape.RelativePosition.y;
    const bottom = sy + last.PositionAndShape.RelativePosition.y + last.StaffHeight;
    return {
      x: entry.PositionAndShape.AbsolutePosition.x * zoom,
      top: top * zoom,
      height: (bottom - top) * zoom,
    };
  }

  /**
   * Put the cursor band over the notes `refs` (one step), as OSMD would:
   * 3 units wide, starting 1.5 before the leftmost note, the system's height.
   */
  showCursor(refs: readonly number[]) {
    this.gliding = false;
    this.cursor.classList.remove("gliding");
    this.cursorRefs = refs;
    const spots = refs.map((r) => this.spots[r]).filter((x): x is Spot => !!x);
    if (!spots.length) {
      this.cursor.hidden = true;
      return;
    }
    const left = spots.reduce((a, b) => (b.x < a.x ? b : a));
    const zoom = UNIT * this.osmd.Zoom;
    // CSSOM, not a style attribute: the CSP governs only the latter.
    this.cursor.style.left = `${left.x - 1.5 * zoom}px`;
    this.cursor.style.top = `${left.top}px`;
    this.cursor.style.width = `${3 * zoom}px`;
    this.cursor.style.height = `${left.height}px`;
    this.cursor.hidden = false;
  }

  /**
   * The note a click lands on: in the system under the click (its staves'
   * band, with some room above and below), the first note at or right of
   * the click, or that system's last note when clicking past the end.
   */
  refAt(clientX: number, clientY: number): number | null {
    const box = this.page.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    const slack = UNIT * this.osmd.Zoom * 3;
    let best: number | null = null;
    let bestX = Infinity;
    let last: number | null = null;
    let lastX = -Infinity;
    this.spots.forEach((s, ref) => {
      if (!s || y < s.top - slack || y > s.top + s.height + slack) return;
      if (s.x >= x - slack / 2 && s.x < bestX) [best, bestX] = [ref, s.x];
      if (s.x > lastX) [last, lastX] = [ref, s.x];
    });
    return best ?? last;
  }

  /**
   * While playing: put the cursor `frac` of the way from the notes `from`
   * to the notes `to`, as the time between them passes. In the continuous
   * view the score scrolls so that point stays put on screen: the music
   * flows past a still cursor, at whatever speed the tempo, zoom and layout
   * give. In page view the cursor glides along a line, and jumps to the next.
   */
  glide(from: readonly number[], to: readonly number[], frac: number) {
    const leftmost = (refs: readonly number[]) =>
      refs.map((r) => this.spots[r]).filter((x): x is Spot => !!x)
        .reduce<Spot | null>((a, b) => (!a || b.x < a.x ? b : a), null);
    const a = leftmost(from);
    if (!a) return;
    const b = leftmost(to) ?? a;
    const sameLine = Math.abs(a.top - b.top) < 1;
    const x = sameLine ? a.x + (b.x - a.x) * Math.min(1, Math.max(0, frac)) : a.x;
    const zoom = UNIT * this.osmd.Zoom;
    this.cursorRefs = from;
    this.gliding = true;
    this.cursor.classList.add("gliding");
    this.cursor.style.left = `${x - 1.5 * zoom}px`;
    this.cursor.style.top = `${a.top}px`;
    this.cursor.style.width = `${3 * zoom}px`;
    this.cursor.style.height = `${a.height}px`;
    this.cursor.hidden = false;
    if (this.line) {
      // x is within the page; the page's own offset inside the scroll box
      // (not offsetLeft, which is relative to an outer positioned element).
      const inBox = this.page.getBoundingClientRect().left -
        this.container.getBoundingClientRect().left + this.container.scrollLeft;
      const left = x + inBox - this.container.clientWidth * LINE_ANCHOR;
      this.container.scrollTo({ left: Math.max(0, left), behavior: "instant" });
    }
  }

  hideCursor() {
    this.gliding = false;
    this.cursor.classList.remove("gliding");
    this.cursorRefs = null;
    this.cursor.hidden = true;
  }

  private apply(ref: number, mark: StepMark | null) {
    const g = this.elements[ref];
    if (!g) return;
    g.classList.remove(...MARKS);
    if (mark) g.classList.add(mark);
  }

  mark(refs: readonly number[], mark: StepMark | null) {
    for (const r of refs) {
      if (mark) this.marks.set(r, mark);
      else this.marks.delete(r);
      this.apply(r, mark);
    }
  }

  clearMarks() {
    for (const r of this.marks.keys()) this.apply(r, null);
    this.marks.clear();
  }

  /**
   * Tint measures by how they went (the results' heat map, on the score
   * itself): `levels` maps a 0-based measure index to a level 0-4. Drawn as
   * rects behind the notes; the colours come from the stylesheet.
   */
  setHeat(levels: ReadonlyMap<number, number>) {
    this.heat = new Map(levels);
    this.drawHeat();
  }

  clearHeat() {
    if (!this.heat.size) return;
    this.heat.clear();
    this.drawHeat();
  }

  private drawHeat() {
    const svg = this.container.querySelector("svg");
    if (!svg) return;
    for (const r of svg.querySelectorAll(".heat-tint")) r.remove();
    const list = (this.osmd.GraphicSheet as unknown as { MeasureList?: OsmdMeasure[][] })
      ?.MeasureList;
    const zoom = UNIT * this.osmd.Zoom;
    const rects: SVGRectElement[] = [];
    for (const [index, level] of this.heat) {
      let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const m of list?.[index] ?? []) {
        const line = m?.ParentStaffLine;
        if (!m || !line) continue;
        const box = m.PositionAndShape;
        x0 = Math.min(x0, box.AbsolutePosition.x + box.BorderLeft);
        x1 = Math.max(x1, box.AbsolutePosition.x + box.BorderRight);
        const top = line.PositionAndShape.AbsolutePosition.y;
        y0 = Math.min(y0, top);
        y1 = Math.max(y1, top + line.StaffHeight);
      }
      if (!Number.isFinite(x0 + x1 + y0 + y1)) continue;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", `heat-tint level-${level}`);
      rect.setAttribute("x", String(x0 * zoom));
      rect.setAttribute("y", String((y0 - 1) * zoom));
      rect.setAttribute("width", String((x1 - x0) * zoom));
      rect.setAttribute("height", String((y1 - y0 + 2) * zoom));
      rects.push(rect);
    }
    // First in the svg, so behind the staff lines and notes.
    svg.prepend(...rects);
  }

  /** Each measure's rectangle on the page (px), across all its staves. */
  private measureBoxes(): MeasureBox[] {
    const list = (this.osmd.GraphicSheet as unknown as { MeasureList?: OsmdMeasure[][] })
      ?.MeasureList;
    const zoom = UNIT * this.osmd.Zoom;
    const out: MeasureBox[] = [];
    list?.forEach((staves, index) => {
      let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const m of staves ?? []) {
        const line = m?.ParentStaffLine;
        if (!m || !line) continue;
        const box = m.PositionAndShape;
        x0 = Math.min(x0, box.AbsolutePosition.x + box.BorderLeft);
        x1 = Math.max(x1, box.AbsolutePosition.x + box.BorderRight);
        const top = line.PositionAndShape.AbsolutePosition.y;
        y0 = Math.min(y0, top);
        y1 = Math.max(y1, top + line.StaffHeight);
      }
      if (!Number.isFinite(x0 + x1 + y0 + y1)) return;
      out.push({ index, x0: x0 * zoom, x1: x1 * zoom, y0: (y0 - 1) * zoom, y1: (y1 + 1) * zoom });
    });
    return out;
  }

  private measureUnder(clientX: number, clientY: number): number | null {
    const box = this.page.getBoundingClientRect();
    return measureAt(this.measureBoxes(), clientX - box.left, clientY - box.top);
  }

  private drawSelection() {
    const svg = this.container.querySelector("svg");
    if (!svg) return;
    for (const r of svg.querySelectorAll(".sel-tint")) r.remove();
    if (!this.sel) return;
    const boxes = this.measureBoxes().filter((b) =>
      b.index >= this.sel!.from && b.index <= this.sel!.to
    );
    const rects = boxes.map((b) => {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", "sel-tint");
      rect.setAttribute("x", String(b.x0));
      rect.setAttribute("y", String(b.y0));
      rect.setAttribute("width", String(b.x1 - b.x0));
      rect.setAttribute("height", String(b.y1 - b.y0));
      return rect;
    });
    svg.prepend(...rects);
  }

  /** Fade the measures outside the practice range (1-based `from`..`to` of `count`). */
  setPracticeRange(count: number, from: number, to: number) {
    this.dimmed = outsideRange(count, from, to);
    this.drawDim();
  }

  /** Paper-coloured rects over the dimmed measures, on top of the notes. */
  private drawDim() {
    const svg = this.container.querySelector("svg");
    if (!svg) return;
    for (const r of svg.querySelectorAll(".range-dim")) r.remove();
    if (!this.dimmed.length) return;
    const out = new Set(this.dimmed);
    for (const b of this.measureBoxes()) {
      if (!out.has(b.index)) continue;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", "range-dim");
      rect.setAttribute("x", String(b.x0));
      rect.setAttribute("y", String(b.y0));
      rect.setAttribute("width", String(b.x1 - b.x0));
      rect.setAttribute("height", String(b.y1 - b.y0));
      svg.append(rect);
    }
  }

  private setSelection(sel: { from: number; to: number } | null) {
    this.sel = sel;
    this.drawSelection();
  }

  /**
   * Press and hold on a measure (mouse held still, or a touch long-press),
   * then drag: the measures from there to the pointer are highlighted, and
   * releasing reports the span. A quick click or an ordinary drag is
   * untouched. Escape, or a second pointer going down, cancels.
   */
  private wireSelect(page: HTMLElement) {
    const stop = () => {
      const s = this.selecting;
      if (!s) return;
      clearTimeout(s.timer);
      clearInterval(s.scroller);
      if (s.active && page.hasPointerCapture(s.pointer)) page.releasePointerCapture(s.pointer);
      this.selecting = null;
      this.setSelection(null);
    };
    const update = () => {
      const s = this.selecting;
      if (!s?.active) return;
      const at = this.measureUnder(s.x, s.y);
      if (at !== null) this.setSelection(spanBetween(s.anchor, at));
    };
    const autoScroll = () => {
      const s = this.selecting;
      if (!s?.active) return;
      const v = this.container.getBoundingClientRect();
      const edge = 40;
      const step = (pos: number, lo: number, hi: number) =>
        pos < lo + edge
          ? -Math.ceil((lo + edge - pos) / 4)
          : pos > hi - edge
          ? Math.ceil((pos - (hi - edge)) / 4)
          : 0;
      const dx = step(s.x, v.left, v.right);
      const dy = step(s.y, v.top, v.bottom);
      if (dx || dy) {
        this.container.scrollBy({ left: dx, top: dy, behavior: "instant" });
        update();
      }
    };
    page.addEventListener("pointerdown", (e) => {
      if (this.selecting) { // a second press while selecting cancels
        stop();
        return;
      }
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const anchor = this.measureUnder(e.clientX, e.clientY);
      if (anchor === null) return;
      const s = {
        anchor,
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        start: { x: e.clientX, y: e.clientY },
        active: false,
        scroller: 0,
        timer: 0,
      };
      s.timer = setTimeout(() => {
        s.active = true;
        page.setPointerCapture(s.pointer);
        s.scroller = setInterval(autoScroll, 30);
        this.setSelection({ from: anchor, to: anchor });
      }, LONG_PRESS_MS);
      this.selecting = s;
    });
    page.addEventListener("pointermove", (e) => {
      const s = this.selecting;
      if (!s || e.pointerId !== s.pointer) return;
      s.x = e.clientX;
      s.y = e.clientY;
      if (s.active) return update();
      if (!stillHolding(s.start, s)) stop(); // an ordinary drag or scroll
    });
    const release = (e: PointerEvent) => {
      const s = this.selecting;
      if (!s || e.pointerId !== s.pointer) return;
      const sel = s.active ? this.sel : null;
      stop();
      if (sel) {
        this.swallowClick = true; // the release is not a seek
        setTimeout(() => this.swallowClick = false, 400);
        this.onSelectRange(sel.from + 1, sel.to + 1);
      }
    };
    page.addEventListener("pointerup", release);
    page.addEventListener("pointercancel", () => stop());
    // While selecting, the touch must not scroll the page or open a menu.
    page.addEventListener("touchmove", (e) => {
      if (this.selecting?.active) e.preventDefault();
    }, { passive: false });
    page.addEventListener("contextmenu", (e) => {
      if (this.selecting?.active) e.preventDefault();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.selecting) stop();
    });
  }

  /** Scroll so the note `ref` is in view, keeping the line above it visible. */
  reveal(ref: number) {
    const g = this.elements[ref];
    if (!g) return;
    const box = g.getBoundingClientRect();
    const view = this.container.getBoundingClientRect();
    if (this.line) {
      if (this.gliding) return; // glide() scrolls, continuously
      // One long line: keep the current note near the left, so most of
      // what's coming next is in view.
      const want = view.left + view.width * LINE_ANCHOR;
      if (Math.abs(box.left - want) > view.width / 6) {
        this.container.scrollBy({ left: box.left - want, behavior: "smooth" });
      }
      return;
    }
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
      this.container.scrollBy({ top: box.top - view.top - view.height / 3, behavior: "smooth" });
    }
  }

  /**
   * Page view (systems wrapped to the width) or one continuous line that
   * scrolls to the right, with no line breaks.
   */
  setLineView(line: boolean) {
    if (line === this.line) return;
    this.line = line;
    this.container.classList.toggle("line-view", line);
    this.osmd.setOptions({ renderSingleHorizontalStaffline: line });
    if (this.loaded) this.render();
  }

  /** Notation size, 1 = OSMD's default. */
  setZoom(zoom: number) {
    this.osmd.Zoom = zoom;
    if (this.loaded) this.render();
  }
}
