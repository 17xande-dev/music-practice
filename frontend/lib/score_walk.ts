// The OSMD cursor walk, split from score_view.ts so it needs no DOM beyond
// what OSMD itself touches: the songs page uses it (through ScoreView.walk)
// and tools/score_fixtures.ts runs it headless under jsdom.

import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { chooseParts, type RawEntry, type RawNote } from "./score.ts";
import { type Letter, spell } from "./theory.ts";

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
export interface OsmdInstrument {
  Staves: unknown[];
  Name?: string;
}

/** The parts to grade (see chooseParts), each with its first staff's number. */
export function playedParts(osmd: OpenSheetMusicDisplay): Map<OsmdInstrument, number> {
  const all = osmd.Sheet.Instruments as unknown as OsmdInstrument[];
  const choice = chooseParts(all.map((i) => ({ name: i.Name ?? "", staves: i.Staves.length })));
  return new Map(choice.map((c) => [all[c.part], c.staffOffset]));
}

/** The parts of a source measure read for its printed number. */
interface OsmdMeasure {
  MeasureNumberXML?: number;
  ImplicitMeasureFromXml?: boolean;
  getPrintedMeasureNumber?(): number;
}

/**
 * The number printed on a measure. An implicit measure whose number attribute is not a plain
 * integer ("X1") continues the previous measure's number (0, 1, 1, 2): OSMD would count it as a
 * new bar, which makes the numbers run past the next real bar.
 */
function printedNumber(measures: OsmdMeasure[], index: number): number | undefined {
  const m = measures[index];
  if (m?.ImplicitMeasureFromXml && !Number.isInteger(m.MeasureNumberXML) && index > 0) {
    return printedNumber(measures, index - 1);
  }
  return m?.getPrintedMeasureNumber?.();
}

/**
 * Walk the cursor through the piece, repeats played out. `onNote` is called
 * for each note kept, in order, with OSMD's own note object, and returns the
 * note's `ref` (the view uses it to record the note's SVG element).
 */
export function walkCursor(
  osmd: OpenSheetMusicDisplay,
  onNote: (raw: unknown) => number,
): RawEntry[] {
  const cursor = osmd.cursor;
  const played = playedParts(osmd);
  const out: RawEntry[] = [];
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
      notes.push({
        midi,
        spelled: spell(midi, LETTER_OF[n.Pitch.FundamentalNote] ?? "C"),
        staff: offset + Math.max(0, inst.Staves.indexOf(n.ParentStaff)),
        tie,
        quarters,
        finger: n.Fingering?.value || undefined,
        ref: onNote(raw),
      });
    }
    // The number printed on the score (a pickup is 0), where OSMD has one.
    const printed = printedNumber(osmd.Sheet.SourceMeasures as unknown as OsmdMeasure[], mi);
    out.push({
      measure: mi + 1,
      ...(Number.isInteger(printed) ? { printed } : {}),
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
