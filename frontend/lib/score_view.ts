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
import { chooseParts, type RawEntry, type RawNote } from "./score.ts";
import type { StepMark } from "./staff_view.ts";
import { type Letter, spell } from "./theory.ts";

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
interface OsmdGNote {
  getSVGGElement?(): SVGGElement;
  parentVoiceEntry?: {
    parentStaffEntry?: {
      PositionAndShape: OsmdBox;
      parentMeasure?: { ParentMusicSystem?: OsmdSystem };
    };
  };
}
/** OSMD lays out in units of 10 px at zoom 1. */
const UNIT = 10;

const MARKS: StepMark[] = ["current", "ok", "bad", "early", "late"];
/** OSMD's NoteEnum: semitones above C of each natural letter. */
const LETTER_OF: Record<number, Letter> = {
  0: "C",
  2: "D",
  4: "E",
  5: "F",
  7: "G",
  9: "A",
  11: "B",
};

/** The parts of OSMD's object model this file reads (its typings are loose). */
interface OsmdNote {
  halfTone: number;
  IsGraceNote: boolean;
  PrintObject: boolean;
  isRest(): boolean;
  Pitch: { FundamentalNote: number } | null;
  Length: { RealValue: number };
  NoteTie?: { StartNote: OsmdNote; Duration: { RealValue: number } } | null;
  Fingering?: { value?: string } | null;
  ParentStaff: { ParentInstrument: OsmdInstrument };
}
interface OsmdInstrument {
  Staves: unknown[];
  Name?: string;
}

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
  private marks = new Map<number, StepMark>();
  private loaded = false;
  private lastWidth = 0;
  /** Called after a re-render (resize, theme), when refs point at new elements. */
  onRender: () => void = () => {};

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
    // OSMD replaces the page's contents when it renders.
    this.page.append(this.cursor);
    if (this.cursorRefs) this.showCursor(this.cursorRefs);
    this.onRender();
  }

  /** The parts to grade (see chooseParts), each with its first staff's number. */
  private played(): Map<OsmdInstrument, number> {
    const all = this.osmd.Sheet.Instruments as unknown as OsmdInstrument[];
    const choice = chooseParts(all.map((i) => ({ name: i.Name ?? "", staves: i.Staves.length })));
    return new Map(choice.map((c) => [all[c.part], c.staffOffset]));
  }

  /**
   * Walk the cursor through the piece, repeats played out. Also refreshes
   * the ref → SVG element table, so it runs after every render.
   */
  walk(): RawEntry[] {
    const cursor = this.osmd.cursor;
    const rules = this.osmd.EngravingRules;
    const played = this.played();
    const out: RawEntry[] = [];
    this.elements = [];
    this.spots = [];
    if (!cursor || !played.size) return out;
    cursor.reset();
    const it = cursor.iterator;
    let occurrence = 0;
    let prevMeasure = -1;
    let prevRel = Infinity;
    // A bound on positions, in case a malformed repeat structure loops.
    for (let guard = 0; !it.EndReached && guard < 200000; guard++) {
      const mi = it.CurrentMeasureIndex;
      const rel = it.CurrentRelativeInMeasureTimestamp.RealValue;
      if (mi !== prevMeasure || rel <= prevRel) occurrence++;
      prevMeasure = mi;
      prevRel = rel;
      const notes: RawNote[] = [];
      for (const raw of cursor.NotesUnderCursor()) {
        const n = raw as unknown as OsmdNote;
        if (n.isRest() || n.IsGraceNote || !n.PrintObject || !n.Pitch) continue;
        const inst = n.ParentStaff.ParentInstrument;
        const offset = played.get(inst);
        if (offset === undefined) continue;
        const midi = n.halfTone + 12;
        const tie = n.NoteTie ? (n.NoteTie.StartNote === n ? "start" : "continue") : "none";
        const quarters = 4 *
          (tie === "start" && n.NoteTie ? n.NoteTie.Duration.RealValue : n.Length.RealValue);
        const ref = this.elements.length;
        let el: SVGGElement | null = null;
        let spot: Spot | null = null;
        try {
          const g = rules.GNote(raw) as unknown as OsmdGNote | undefined;
          el = g?.getSVGGElement?.() ?? null;
          spot = this.spotOf(g);
        } catch {
          el = null;
        }
        this.elements.push(el);
        this.spots.push(spot);
        notes.push({
          midi,
          spelled: spell(midi, LETTER_OF[n.Pitch.FundamentalNote] ?? "C"),
          staff: offset +
            Math.max(
              0,
              inst.Staves.indexOf((raw as unknown as { ParentStaff: unknown }).ParentStaff),
            ),
          tie,
          quarters,
          finger: n.Fingering?.value || undefined,
          ref,
        });
      }
      out.push({
        measure: mi + 1,
        occurrence,
        beat: it.CurrentEnrolledTimestamp.RealValue * 4,
        bpm: it.CurrentBpm,
        notes,
      });
      cursor.next();
    }
    cursor.reset();
    return out;
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

  hideCursor() {
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

  /** Scroll so the note `ref` is in view, keeping the line above it visible. */
  reveal(ref: number) {
    const g = this.elements[ref];
    if (!g) return;
    const box = g.getBoundingClientRect();
    const view = this.container.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
      this.container.scrollBy({ top: box.top - view.top - view.height / 3, behavior: "smooth" });
    }
  }
}
