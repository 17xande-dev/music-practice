// Staff notation for the exercise, drawn with VexFlow: one staff for one
// hand, a braced grand staff for hands together. The exercise is wrapped
// into lines that fit the container, and each step's notes can be marked
// (current, ok, bad, early, late) by class, without redrawing.

import {
  Accidental,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  Voice,
} from "vexflow/bravura";
import type { Hand, Spelled, Step } from "./theory.ts";

export type StepMark = "current" | "ok" | "bad" | "early" | "late";
const MARKS: StepMark[] = ["current", "ok", "bad", "early", "late"];

const MAJOR_BY_FIFTHS: Record<number, string> = {
  [-7]: "Cb",
  [-6]: "Gb",
  [-5]: "Db",
  [-4]: "Ab",
  [-3]: "Eb",
  [-2]: "Bb",
  [-1]: "F",
  0: "C",
  1: "G",
  2: "D",
  3: "A",
  4: "E",
  5: "B",
  6: "F#",
  7: "C#",
};

const ACC: Record<number, string> = { [-2]: "bb", [-1]: "b", 0: "", 1: "#", 2: "##" };

/** VexFlow's key string for a spelled note, e.g. "f#/4". */
export function vfKey(s: Spelled): string {
  return `${s.letter.toLowerCase()}${ACC[s.acc]}/${s.octave}`;
}

/** VexFlow key-signature name for a circle-of-fifths position. */
export function keySpec(fifths: number | null): string {
  return fifths === null ? "C" : MAJOR_BY_FIFTHS[fifths] ?? "C";
}

/**
 * Clef for one hand's notes on one line. Each hand keeps its home clef
 * (treble for RH, bass for LH) unless the line's middle note is well into
 * the other clef's range, so a four-octave run is not drawn on eight ledger
 * lines, but a scale around middle C does not flip clefs needlessly.
 */
export function clefFor(midis: number[], hand: Hand): "treble" | "bass" {
  const sorted = [...midis].sort((a, b) => a - b);
  const mid = sorted[sorted.length >> 1];
  if (hand === "rh") return mid < 59 ? "bass" : "treble"; // below B3
  return mid > 65 ? "treble" : "bass"; // above F4
}

/** How many notes fit on a line of `width` pixels. */
export function notesPerLine(width: number): number {
  return Math.max(6, Math.min(16, Math.floor((width - 120) / 44)));
}

// Vertical layout, in px. Generous above and below each staff because
// scales run into ledger lines.
const STAFF_GAP = 125; // treble top to bass top in a grand staff
const TOP_PAD = 45;
const SINGLE_SYSTEM = 170;
const GRAND_SYSTEM = SINGLE_SYSTEM + STAFF_GAP;

export class StaffView {
  private steps: readonly Step[] = [];
  private fifths: number | null = null;
  private groups: SVGElement[][] = [];
  private systemTops: number[] = [];
  private lineOf: number[] = [];
  private marks: (StepMark | null)[] = [];
  private lastWidth = 0;

  constructor(private container: HTMLElement) {
    new ResizeObserver(() => {
      const w = this.container.clientWidth;
      if (this.steps.length && Math.abs(w - this.lastWidth) > 24) this.draw();
    }).observe(container);
    // The ink colour is baked into the drawing, so a theme switch redraws.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
  }

  render(steps: readonly Step[], fifths: number | null) {
    this.steps = steps;
    this.fifths = fifths;
    this.marks = steps.map(() => null);
    this.draw();
  }

  private draw() {
    const width = Math.max(320, this.container.clientWidth - 2);
    this.lastWidth = this.container.clientWidth;
    this.container.replaceChildren();
    this.groups = this.steps.map(() => []);
    this.systemTops = [];
    this.lineOf = [];
    if (!this.steps.length) return;

    const hands: Hand[] = this.steps[0].notes.map((n) => n.hand);
    const grand = hands.length > 1;
    const per = notesPerLine(width);
    const lines: (readonly Step[])[] = [];
    for (let i = 0; i < this.steps.length; i += per) lines.push(this.steps.slice(i, i + per));
    const systemH = grand ? GRAND_SYSTEM : SINGLE_SYSTEM;

    const renderer = new Renderer(this.container as HTMLDivElement, Renderer.Backends.SVG);
    renderer.resize(width, lines.length * systemH);
    const ctx = renderer.getContext();
    const ink = getComputedStyle(this.container).color || "#000";
    ctx.setFillStyle(ink);
    ctx.setStrokeStyle(ink);
    const svg = this.container.querySelector("svg");
    svg?.setAttribute("role", "img");
    svg?.setAttribute("aria-label", "The scale in staff notation");

    const key = keySpec(this.fifths);
    // The grand staff's brace is drawn left of the staves.
    const left = grand ? 30 : 8;
    lines.forEach((line, li) => {
      const top = li * systemH;
      this.systemTops.push(top);
      const staves: Stave[] = [];
      const voices: Voice[] = [];
      const notesByHand: StaveNote[][] = [];
      hands.forEach((hand, h) => {
        const midis = line.map((s) => s.notes[h].midi);
        const clef = clefFor(midis, hand);
        const stave = new Stave(left, top + TOP_PAD + h * STAFF_GAP, width - left - 8);
        stave.addClef(clef).addKeySignature(key).setContext(ctx);
        staves.push(stave);
        const notes = line.map((s) =>
          new StaveNote({ keys: [vfKey(s.notes[h].spelled)], duration: "q", clef, autoStem: true })
        );
        notesByHand.push(notes);
        const voice = new Voice({ numBeats: notes.length, beatValue: 4 }).setMode(Voice.Mode.SOFT);
        voice.addTickables(notes);
        voices.push(voice);
      });
      // Adds the accidentals the key signature does not already imply,
      // including naturals where a raised note returns (melodic minor
      // coming down). Accidentals carry through a line, as through a bar.
      Accidental.applyAccidentals(voices, key);
      const startX = Math.max(...staves.map((s) => s.getNoteStartX()));
      staves.forEach((s) => s.setNoteStartX(startX));
      new Formatter().joinVoices(voices).format(voices, width - 8 - startX - 20);
      staves.forEach((s) => s.draw());
      if (grand) {
        new StaveConnector(staves[0], staves[1]).setType("brace").setContext(ctx).draw();
        new StaveConnector(staves[0], staves[1]).setType("singleLeft").setContext(ctx).draw();
      }
      voices.forEach((v, h) => v.draw(ctx, staves[h]));

      line.forEach((s, i) => {
        this.lineOf[s.index] = li;
        for (const notes of notesByHand) {
          const g = notes[i].getSVGElement();
          if (g) this.groups[s.index].push(g);
        }
      });
    });
    this.marks.forEach((m, i) => this.apply(i, m));
  }

  private apply(step: number, mark: StepMark | null) {
    for (const g of this.groups[step] ?? []) {
      g.classList.remove(...MARKS);
      if (mark) g.classList.add(mark);
    }
  }

  mark(step: number, mark: StepMark | null) {
    if (step < 0 || step >= this.marks.length) return;
    this.marks[step] = mark;
    this.apply(step, mark);
  }

  clearMarks() {
    this.marks = this.marks.map(() => null);
    this.groups.forEach((_, i) => this.apply(i, null));
  }

  /** Scroll the container so the line holding `step` is in view. */
  reveal(step: number) {
    const line = this.lineOf[step];
    if (line === undefined) return;
    const top = this.systemTops[line];
    const c = this.container;
    const h = (this.steps[0]?.notes.length ?? 1) > 1 ? GRAND_SYSTEM : SINGLE_SYSTEM;
    if (top < c.scrollTop || top + h > c.scrollTop + c.clientHeight) {
      c.scrollTo({ top, behavior: "smooth" });
    }
  }
}
