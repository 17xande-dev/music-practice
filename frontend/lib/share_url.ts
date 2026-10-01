// Exercise setups as query strings, so a link reproduces an exercise:
// /?instrument=piano&key=F%23&scale=harmonic-minor&hands=both&octaves=2&dir=updown&mode=tempo&bpm=90&beat=2
//
// Only what defines the exercise is shared. Device-specific settings
// (MIDI device, latency offset, tuning reference) stay with each player.
// Parameters that don't apply are left out (hands on guitar, tempo in
// notes-only mode) to keep links short. Reading goes through
// validSettings, the same check stored settings pass, so a hand-edited
// link can't put anything into the page that the form couldn't.

import { type Settings, validSettings } from "./progress_store.ts";
import type { PitchName } from "./theory.ts";

export type SharedSettings = Pick<
  Settings,
  | "instrument"
  | "tonic"
  | "type"
  | "hands"
  | "octaves"
  | "direction"
  | "mode"
  | "bpm"
  | "notesPerBeat"
  | "position"
  | "fingering"
>;

const ACC_OUT: Record<number, string> = { [-2]: "bb", [-1]: "b", 0: "", 1: "#", 2: "x" };

/** "F#", "Bb", "C": readable in a URL (the # is percent-encoded). */
export function tonicText(p: PitchName): string {
  return p.letter + ACC_OUT[p.acc];
}

/** Parse "F#", "f♯", "Bb", "Ebb", "Fx", "F##"; null if it isn't a note name. */
export function parseTonic(text: string): PitchName | null {
  const m = /^([A-Ga-g])(#|##|x|♯|𝄪|b|bb|♭|𝄫)?$/.exec(text.trim());
  if (!m) return null;
  const accs: Record<string, number> = {
    "": 0,
    "#": 1,
    "♯": 1,
    "##": 2,
    "x": 2,
    "𝄪": 2,
    "b": -1,
    "♭": -1,
    "bb": -2,
    "𝄫": -2,
  };
  return { letter: m[1].toUpperCase() as PitchName["letter"], acc: accs[m[2] ?? ""] };
}

/** The query string for a setup, without the leading "?". */
export function toQuery(s: SharedSettings): string {
  const q = new URLSearchParams();
  q.set("instrument", s.instrument);
  q.set("key", tonicText(s.tonic));
  q.set("scale", s.type);
  if (s.instrument === "guitar") q.set("position", String(s.position));
  else q.set("hands", s.hands);
  q.set("octaves", String(s.octaves));
  q.set("dir", s.direction);
  q.set("mode", s.mode);
  if (s.mode === "tempo") {
    q.set("bpm", String(s.bpm));
    q.set("beat", String(s.notesPerBeat));
  }
  if (s.fingering) q.set("fingers", "1");
  return q.toString();
}

/** The settings a query string asks for; anything missing or invalid is left out. */
export function fromQuery(search: string): Partial<Settings> {
  const q = new URLSearchParams(search);
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
  const fingers = q.get("fingers");
  return validSettings({
    instrument: q.get("instrument") ?? undefined,
    tonic: q.has("key") ? parseTonic(q.get("key")!) : undefined,
    type: q.get("scale") ?? undefined,
    hands: q.get("hands") ?? undefined,
    octaves: num("octaves"),
    direction: q.get("dir") ?? undefined,
    mode: q.get("mode") ?? undefined,
    bpm: num("bpm"),
    notesPerBeat: num("beat"),
    position: num("position"),
    fingering: fingers === "1" ? true : fingers === "0" ? false : undefined,
  });
}
