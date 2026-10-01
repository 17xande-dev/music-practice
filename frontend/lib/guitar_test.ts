import { assert, assertEquals } from "@std/assert";
import {
  boxFor,
  type FretPosition,
  layout,
  placesFor,
  positionLabel,
  POSITIONS,
  STANDARD_TUNING,
  tonicMidiFor,
} from "./guitar.ts";
import { buildSteps, nameOf, type PitchName, SCALE_TYPES, tonicOptions } from "./theory.ts";

const P = (s: string): PitchName => ({
  letter: s[0] as PitchName["letter"],
  acc: { "": 0, "#": 1, "b": -1 }[s.slice(1)]!,
});

const STRINGS = ["E", "A", "D", "G", "B", "e"];
const tab = (p: FretPosition) => `${STRINGS[p.string]}${p.fret}`;

function scaleLayout(tonic: string, position: number, octaves = 2) {
  const box = boxFor(position);
  const steps = buildSteps({
    tonic: P(tonic),
    type: "major",
    octaves,
    direction: "up",
    hands: "rh",
    tonicMidi: tonicMidiFor(P(tonic), box),
  });
  const midis = steps.map((s) => s.notes[0].midi);
  const map = layout(midis, box);
  return { midis, positions: midis.map((m) => map.get(m)!) };
}

Deno.test("boxes: open position, and four frets plus a stretch elsewhere", () => {
  assertEquals(boxFor(0), { position: 0, lo: 0, hi: 4, stretchLo: 0, stretchHi: 5 });
  assertEquals(boxFor(5), { position: 5, lo: 5, hi: 8, stretchLo: 4, stretchHi: 9 });
  assertEquals(positionLabel(0), "Open position");
  assertEquals(positionLabel(2), "2nd position (frets 2–5)");
  assertEquals(positionLabel(11), "11th position (frets 11–14)");
  assertEquals(POSITIONS.length, 13);
});

// The textbook two-octave G major fingering in 2nd position.
Deno.test("G major, 2nd position: the standard box fingering", () => {
  const { midis, positions } = scaleLayout("G", 2);
  assertEquals(midis[0], 43); // G2, 6th string 3rd fret
  assertEquals(
    positions.map(tab).join(" "),
    "E3 E5 A2 A3 A5 D2 D4 D5 G2 G4 G5 B3 B5 e2 e3",
  );
  assert(positions.every((p) => p.inBox));
});

Deno.test("C major, open position: open strings preferred", () => {
  const { midis, positions } = scaleLayout("C", 0, 1);
  assertEquals(midis[0], 48); // C3, 5th string 3rd fret
  assertEquals(positions.map(tab).join(" "), "A3 D0 D2 D3 G0 G2 B0 B1");
});

Deno.test("A major, 5th position: the tonic on the 6th string 5th fret", () => {
  const { midis, positions } = scaleLayout("A", 5);
  assertEquals(midis[0], 45);
  assertEquals(tab(positions[0]), "E5");
  assert(positions.every((p) => p.fret >= 4 && p.fret <= 9), positions.map(tab).join(" "));
});

// Every tonic of every scale type starts inside (or a stretch from) every
// position, and every placement really sounds the note it is placed for.
Deno.test("every tonic × type × position: a reachable start, and placements that sound right", () => {
  let checked = 0;
  for (const type of SCALE_TYPES) {
    for (const opt of tonicOptions(type)) {
      const tonic = opt.spellings[0];
      for (const position of POSITIONS) {
        const box = boxFor(position);
        const t = tonicMidiFor(tonic, box);
        const fret0 = [0, 1, 2].map((st) => t - STANDARD_TUNING[st]);
        assert(
          fret0.some((f) => f >= box.stretchLo && f <= box.stretchHi),
          `${nameOf(tonic)} at position ${position}: ${t}`,
        );
        const steps = buildSteps({
          tonic,
          type,
          octaves: 1,
          direction: "updown",
          hands: "rh",
          tonicMidi: t,
        });
        const midis = steps.map((s) => s.notes[0].midi);
        const map = layout(midis, box);
        for (const m of midis) {
          const p = map.get(m);
          assert(p, `no place for ${m}`);
          assertEquals(STANDARD_TUNING[p.string] + p.fret, m);
        }
        checked++;
      }
    }
  }
  assert(checked >= 13 * 12 * 13);
});

// One-octave major scales fit entirely inside the box in every position.
Deno.test("one-octave major scales stay inside the box", () => {
  for (const position of POSITIONS.slice(1)) {
    for (const t of ["C", "G", "D", "A", "E", "F", "Bb"]) {
      const { positions } = scaleLayout(t, position, 1);
      assert(
        positions.every((p) => p.inBox),
        `${t} at ${position}: ${positions.map(tab).join(" ")}`,
      );
    }
  }
});

Deno.test("placesFor lists every string that can play a note", () => {
  assertEquals(placesFor(40).map(tab), ["E0"]);
  assertEquals(
    placesFor(64).map(tab),
    // E4: frets beyond 15 (E24, A19) are off the drawn neck.
    ["D14", "G9", "B5", "e0"],
  );
  assertEquals(placesFor(55).length, 4); // G3: E15, A10, D5, G0
});

Deno.test("buildSteps honours a tonicMidi override", () => {
  const steps = buildSteps({
    tonic: P("E"),
    type: "major",
    octaves: 1,
    direction: "up",
    hands: "rh",
    tonicMidi: 40,
  });
  assertEquals(steps[0].notes[0].midi, 40);
  assertEquals(steps.at(-1)!.notes[0].midi, 52);
  assertEquals(steps[0].notes[0].spelled.octave, 2);
});
