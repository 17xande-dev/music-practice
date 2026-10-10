// Where a note came from: a MIDI instrument, or the screen (the drawn piano
// and the computer's typing keys). The two are not the same practice, so
// every run records which it was and the stats keep them apart.
//
// A record without `input` (made before this existed) reads as "midi".
// The guitar's microphone input counts as "midi": a real instrument, not
// an on-screen stand-in.

export type InputSource = "midi" | "screen";

export const INPUT_DEFAULT: InputSource = "midi";

/** The `input` field of a stored record: absent, or exactly one of the two values. */
export const validInput = (x: unknown): boolean =>
  x === undefined || x === "midi" || x === "screen";

/** A record's input, reading a missing field as "midi". */
export const inputOf = (r: { input?: InputSource }): InputSource => r.input ?? INPUT_DEFAULT;

/** Only the records of one input (older records, without the field, are "midi"). */
export const forInput = <T extends { input?: InputSource }>(rs: T[], input: InputSource): T[] =>
  rs.filter((r) => inputOf(r) === input);

/** The `input` field as stored: "midi" is written out too, never left to the default. */
export const cleanInput = (r: { input?: InputSource }): { input: InputSource } => ({
  input: inputOf(r),
});

/**
 * The input of one run: "screen" as soon as any graded note came from the
 * screen, "midi" only if every one came from MIDI (or the microphone).
 * Note events carry `src`; absent means MIDI.
 */
export class RunInput {
  private screen = false;

  note(ev: { src?: InputSource }) {
    if (ev.src === "screen") this.screen = true;
  }

  get value(): InputSource {
    return this.screen ? "screen" : "midi";
  }

  reset() {
    this.screen = false;
  }
}
