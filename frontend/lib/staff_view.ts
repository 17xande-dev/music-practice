// Staff notation for the exercise, drawn with VexFlow: one staff for one
// hand, a braced grand staff for hands together. The exercise is wrapped
// into lines that fit the container, and each step's notes can be marked
// (current, ok, bad, early, late) by class, without redrawing.

import {
  Accidental,
  Annotation,
  AnnotationVerticalJustify,
  Beam,
  Formatter,
  Fraction,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  Voice,
} from "vexflow/bravura";
import type { Hand, Spelled, Step } from "./theory.ts";

const INK = "currentColor";

export type StepMark = "current" | "ok" | "bad" | "early" | "late";
/** VexFlow durations: quarter, eighth, sixteenth. */
export type NoteDuration = "q" | "8" | "16";
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

/** Guitar music is written an octave above where it sounds. */
export function writtenPitch(s: Spelled, guitar: boolean): Spelled {
  return guitar ? { ...s, octave: s.octave + 1 } : s;
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
  private duration: NoteDuration = "q";
  private guitar = false;
  private fingers: readonly (readonly (number | null)[])[] | null = null;
  private groups: SVGElement[][] = [];
  private systemTops: number[] = [];
  private lineOf: number[] = [];
  private marks: (StepMark | null)[] = [];
  private lastWidth = 0;
  private systemH = SINGLE_SYSTEM;

  constructor(private container: HTMLElement) {
    new ResizeObserver(() => {
      const w = this.container.clientWidth;
      if (this.steps.length && Math.abs(w - this.lastWidth) > 24) this.draw();
    }).observe(container);
  }

  /**
   * `guitar` draws standard guitar notation: treble clef with an 8 below,
   * notes written an octave above where they sound, so the low E (E2) sits
   * just below the staff rather than on five ledger lines.
   *
   * `fingers` (shaped like the steps: one number per note) writes a finger
   * number by each note, above the staff, or below it for the left hand,
   * as scale books do. 0 is an open string.
   */
  render(
    steps: readonly Step[],
    fifths: number | null,
    opts: {
      duration?: NoteDuration;
      guitar?: boolean;
      fingers?: readonly (readonly (number | null)[])[] | null;
    } = {},
  ) {
    this.steps = steps;
    this.fifths = fifths;
    this.duration = opts.duration ?? "q";
    this.guitar = opts.guitar ?? false;
    this.fingers = opts.fingers ?? null;
    this.marks = steps.map(() => null);
    this.draw();
  }

  /** Show or hide the finger numbers, keeping the marks made so far. */
  setFingers(fingers: readonly (readonly (number | null)[])[] | null) {
    this.fingers = fingers;
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

    const hands: Hand[] = [...new Set(this.steps[0].notes.map((n) => n.hand))];
    const grand = hands.length > 1;
    const per = notesPerLine(width);
    const lines: (readonly Step[])[] = [];
    for (let i = 0; i < this.steps.length; i += per) lines.push(this.steps.slice(i, i + per));
    // Chord fingers stack one above another: make room for the extra rows.
    const perHand = Math.max(
      1,
      ...this.steps.map((s) => s.notes.filter((n) => n.hand === hands[0]).length),
    );
    const extra = this.fingers ? (perHand - 1) * 14 : 0;
    const topPad = TOP_PAD + extra;
    const systemH = (grand ? GRAND_SYSTEM : SINGLE_SYSTEM) + 2 * extra;
    this.systemH = systemH;

    const renderer = new Renderer(this.container as HTMLDivElement, Renderer.Backends.SVG);
    renderer.resize(width, lines.length * systemH);
    const ctx = renderer.getContext();
    // Everything is drawn in currentColor, so the sheet's colour (the site
    // theme, or the sheet's own light/dark switch) is pure CSS: no redraw.
    ctx.setFillStyle(INK);
    ctx.setStrokeStyle(INK);
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
        // This hand's notes in each step, low to high (a chord, or one note),
        // with their index in the step for looking up fingers.
        const handNotes = (s: Step) =>
          s.notes.map((n, i) => ({ n, i })).filter((x) => x.n.hand === hand)
            .sort((a, b) => a.n.midi - b.n.midi);
        const midis = line.flatMap((s) => handNotes(s).map((x) => x.n.midi));
        const clef = this.guitar ? "treble" : clefFor(midis, hand);
        const stave = new Stave(left, top + topPad + h * STAFF_GAP, width - left - 8);
        if (this.guitar) stave.addClef("treble", "default", "8vb");
        else stave.addClef(clef);
        stave.addKeySignature(key).setContext(ctx);
        staves.push(stave);
        const below = hand === "lh" && grand;
        const notes = line.map((s) => {
          const chord = handNotes(s);
          const note = new StaveNote({
            keys: chord.map((x) => vfKey(writtenPitch(x.n.spelled, this.guitar))),
            duration: this.duration,
            clef,
            autoStem: true,
          });
          // Stems and ledger lines carry their own style (black by default).
          note.setStemStyle({ strokeStyle: INK });
          note.setLedgerLineStyle({ strokeStyle: INK });
          // A chord's fingers stack as printed: the lowest note's finger
          // nearest the staff above it, the highest nearest the staff below.
          const order = below ? [...chord].reverse() : chord;
          for (const x of order) {
            const finger = this.fingers?.[s.index]?.[x.i];
            if (finger === undefined || finger === null) continue;
            note.addModifier(
              new Annotation(String(finger)).setVerticalJustification(
                below ? AnnotationVerticalJustify.BOTTOM : AnnotationVerticalJustify.TOP,
              ),
              0,
            );
          }
          return note;
        });
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
      // Eighths and sixteenths are beamed a beat at a time, so the notation
      // reads as the rhythm the metronome asks for. Beams are generated
      // before the voices draw, which suppresses the individual flags.
      const beams = this.duration === "q"
        ? []
        : notesByHand.flatMap((notes) =>
          Beam.generateBeams(notes, { groups: [new Fraction(1, 4)] })
        );
      voices.forEach((v, h) => v.draw(ctx, staves[h]));
      beams.forEach((b) => b.setContext(ctx).draw());

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
    const h = this.systemH;
    if (top < c.scrollTop || top + h > c.scrollTop + c.clientHeight) {
      c.scrollTo({ top, behavior: "smooth" });
    }
  }
}
