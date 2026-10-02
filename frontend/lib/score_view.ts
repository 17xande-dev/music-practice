// The rendered score on the songs page, drawn by OpenSheetMusicDisplay.
//
// OSMD lays out and draws the MusicXML; this wrapper walks its cursor once
// to hand the piece over as plain RawEntry records (score.ts takes it from
// there), and marks notes by class on their SVG groups, as the scales staff
// does, so marking never needs a re-render.
//
// OSMD's own cursor is never shown: it is an <img> with a data: URL, which
// the CSP's img-src refuses. The notes of the current step get the
// "current" class instead.

import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { chooseParts, type RawEntry, type RawNote } from "./score.ts";
import type { StepMark } from "./staff_view.ts";
import { type Letter, spell } from "./theory.ts";

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
  private marks = new Map<number, StepMark>();
  private loaded = false;
  private lastWidth = 0;
  /** Called after a re-render (resize, theme), when refs point at new elements. */
  onRender: () => void = () => {};

  constructor(private readonly container: HTMLElement) {
    // OSMD sizes the score to its element's outer width; an inner element
    // takes the scrolling box's content width, so nothing overflows sideways.
    const page = document.createElement("div");
    container.replaceChildren(page);
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
        try {
          // deno-lint-ignore no-explicit-any
          el = (rules.GNote(raw) as any)?.getSVGGElement?.() ?? null;
        } catch {
          el = null;
        }
        this.elements.push(el);
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
