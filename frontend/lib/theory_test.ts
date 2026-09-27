import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildSteps,
  type ExerciseOptions,
  keySignatureFifths,
  midiOf,
  nameOf,
  pitchClass,
  type PitchName,
  SCALE_TYPES,
  SCALES,
  scaleTitle,
  spell,
  tonicOptions,
} from "./theory.ts";

const P = (s: string): PitchName => {
  const acc = { "": 0, "#": 1, "b": -1, "##": 2, "bb": -2 }[s.slice(1)]!;
  return { letter: s[0] as PitchName["letter"], acc };
};

function names(
  o: Partial<ExerciseOptions> & {
    tonic: PitchName;
    type: ExerciseOptions["type"];
  },
): string[] {
  return buildSteps({ octaves: 1, direction: "up", hands: "rh", ...o }).map((
    s,
  ) => nameOf(s.notes[0].spelled));
}

Deno.test("spell derives accidental and letter-owned octave", () => {
  assertEquals(spell(60, "B"), { letter: "B", acc: 1, octave: 3 }); // B♯3 sounds as C4
  assertEquals(spell(59, "C"), { letter: "C", acc: -1, octave: 4 }); // C♭4 sounds as B3
  assertEquals(spell(67, "F"), { letter: "F", acc: 2, octave: 4 }); // F𝄪4
  for (let m = 21; m <= 108; m++) {
    for (const l of ["C", "D", "E", "F", "G", "A", "B"] as const) {
      const s = spell(m, l);
      if (Math.abs(s.acc) <= 2) assertEquals(midiOf(s), m);
    }
  }
});

Deno.test("known scales are spelled correctly", () => {
  assertEquals(names({ tonic: P("C"), type: "major" }), [
    "C",
    "D",
    "E",
    "F",
    "G",
    "A",
    "B",
    "C",
  ]);
  assertEquals(names({ tonic: P("F#"), type: "major" }), [
    "F♯",
    "G♯",
    "A♯",
    "B",
    "C♯",
    "D♯",
    "E♯",
    "F♯",
  ]);
  assertEquals(names({ tonic: P("Gb"), type: "major" }), [
    "G♭",
    "A♭",
    "B♭",
    "C♭",
    "D♭",
    "E♭",
    "F",
    "G♭",
  ]);
  assertEquals(names({ tonic: P("D"), type: "harmonic-minor" }), [
    "D",
    "E",
    "F",
    "G",
    "A",
    "B♭",
    "C♯",
    "D",
  ]);
  assertEquals(names({ tonic: P("G#"), type: "harmonic-minor" }), [
    "G♯",
    "A♯",
    "B",
    "C♯",
    "D♯",
    "E",
    "F𝄪",
    "G♯",
  ]);
  assertEquals(names({ tonic: P("D"), type: "dorian" }), [
    "D",
    "E",
    "F",
    "G",
    "A",
    "B",
    "C",
    "D",
  ]);
  assertEquals(names({ tonic: P("A"), type: "minor-pentatonic" }), [
    "A",
    "C",
    "D",
    "E",
    "G",
    "A",
  ]);
  assertEquals(names({ tonic: P("C"), type: "blues" }), [
    "C",
    "E♭",
    "F",
    "G♭",
    "G",
    "B♭",
    "C",
  ]);
  assertEquals(names({ tonic: P("F"), type: "major-pentatonic" }), [
    "F",
    "G",
    "A",
    "C",
    "D",
    "F",
  ]);
});

Deno.test("melodic minor rises raised and falls natural", () => {
  const n = names({
    tonic: P("A"),
    type: "melodic-minor",
    direction: "updown",
  });
  assertEquals(n, [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F♯",
    "G♯",
    "A",
    "G",
    "F",
    "E",
    "D",
    "C",
    "B",
    "A",
  ]);
});

Deno.test("chromatic uses sharps up, flats down, and keeps the tonic's spelling", () => {
  const n = names({ tonic: P("Eb"), type: "chromatic", direction: "updown" });
  assertEquals(n.slice(0, 13), [
    "E♭",
    "E",
    "F",
    "F♯",
    "G",
    "G♯",
    "A",
    "A♯",
    "B",
    "C",
    "C♯",
    "D",
    "E♭",
  ]);
  assertEquals(n.slice(12), [
    "E♭",
    "D",
    "D♭",
    "C",
    "B",
    "B♭",
    "A",
    "A♭",
    "G",
    "G♭",
    "F",
    "E",
    "E♭",
  ]);
});

// The whole matrix: every type on every offered tonic spelling, both
// directions, all octave counts. Checks the invariants that make a scale
// playable and readable rather than spot-checking a few keys.
Deno.test("every tonic × type × octaves obeys the invariants", () => {
  let checked = 0;
  for (const type of SCALE_TYPES) {
    const def = SCALES[type];
    const perOctave = def.up.length;
    for (const opt of tonicOptions(type)) {
      for (const tonic of opt.spellings) {
        for (const octaves of [1, 2, 3, 4]) {
          const steps = buildSteps({
            tonic,
            type,
            octaves,
            direction: "updown",
            hands: "rh",
          });
          const n = perOctave * octaves;
          assertEquals(
            steps.length,
            2 * n + 1,
            `${scaleTitle(tonic, type)} ×${octaves}`,
          );
          const midis = steps.map((s) => s.notes[0].midi);
          // Strictly up to the top, strictly down after it.
          for (let i = 1; i <= n; i++) {
            assert(
              midis[i] > midis[i - 1],
              `${scaleTitle(tonic, type)} not ascending`,
            );
          }
          for (let i = n + 1; i < midis.length; i++) {
            assert(midis[i] < midis[i - 1]);
          }
          assertEquals(midis[0], midis[midis.length - 1]);
          assertEquals(midis[n] - midis[0], 12 * octaves);
          for (const s of steps) {
            const sp = s.notes[0].spelled;
            assert(
              Math.abs(sp.acc) <= 2,
              `${scaleTitle(tonic, type)}: ${nameOf(sp)}`,
            );
            assertEquals(midiOf(sp), s.notes[0].midi);
            assert(
              s.notes[0].midi >= 21 && s.notes[0].midi <= 108,
              "off the piano",
            );
          }
          // Ascending pitch classes match the definition.
          for (let i = 0; i < perOctave; i++) {
            assertEquals(
              pitchClass(steps[i].notes[0].spelled),
              (pitchClass(tonic) + def.up[i]) % 12,
            );
          }
          // Seven-note scales use each letter exactly once per octave.
          if (perOctave === 7) {
            const letters = new Set(
              steps.slice(0, 7).map((s) => s.notes[0].spelled.letter),
            );
            assertEquals(letters.size, 7);
          }
          checked++;
        }
      }
    }
  }
  assert(checked >= 13 * 12 * 4, `only ${checked} combinations checked`);
});

Deno.test("hands together: RH first, LH an octave below, same spelling", () => {
  const steps = buildSteps({
    tonic: P("D"),
    type: "major",
    octaves: 2,
    direction: "updown",
    hands: "both",
  });
  assertEquals(steps.length, 29);
  for (const s of steps) {
    assertEquals(s.notes.map((n) => n.hand), ["rh", "lh"]);
    assertEquals(s.notes[0].midi - s.notes[1].midi, 12);
    assertEquals(nameOf(s.notes[0].spelled), nameOf(s.notes[1].spelled));
  }
  assertEquals(steps[0].notes[0].midi, 62); // D4
});

Deno.test("left hand alone starts an octave below the right", () => {
  const rh = buildSteps({
    tonic: P("C"),
    type: "major",
    octaves: 1,
    direction: "up",
    hands: "rh",
  });
  const lh = buildSteps({
    tonic: P("C"),
    type: "major",
    octaves: 1,
    direction: "up",
    hands: "lh",
  });
  assertEquals(rh[0].notes[0].midi, 60);
  assertEquals(lh[0].notes[0].midi, 48);
  assertEquals(lh[0].notes[0].hand, "lh");
});

Deno.test("key signatures", () => {
  assertEquals(keySignatureFifths(P("C"), "major"), 0);
  assertEquals(keySignatureFifths(P("A"), "natural-minor"), 0);
  assertEquals(keySignatureFifths(P("E"), "harmonic-minor"), 1);
  assertEquals(keySignatureFifths(P("Bb"), "major"), -2);
  assertEquals(keySignatureFifths(P("D"), "dorian"), 0);
  assertEquals(keySignatureFifths(P("F"), "lydian"), 0);
  assertEquals(keySignatureFifths(P("G"), "mixolydian"), 0);
  assertEquals(keySignatureFifths(P("B"), "locrian"), 0);
  assertEquals(keySignatureFifths(P("E"), "phrygian"), 0);
  assertEquals(keySignatureFifths(P("C#"), "major"), 7);
  assertEquals(keySignatureFifths(P("C"), "blues"), null);
  assertEquals(keySignatureFifths(P("C"), "chromatic"), null);
});

Deno.test("tonic options: sensible defaults and enharmonic alternatives", () => {
  const major = tonicOptions("major");
  assertEquals(major.length, 12);
  const opt = (pc: number) => major[pc].spellings.map(nameOf);
  assertEquals(opt(0), ["C"]);
  assertEquals(opt(1), ["D♭", "C♯"]); // 5 flats before 7 sharps
  assertEquals(opt(6), ["G♭", "F♯"]); // tie: flat first
  assertEquals(opt(10), ["B♭"]); // A♯ major would need 10 sharps
  assertEquals(opt(11), ["B", "C♭"]);

  const minor = tonicOptions("natural-minor");
  assertEquals(minor[1].spellings.map(nameOf), ["C♯"]); // D♭ minor would need 8 flats
  assertEquals(minor[3].spellings.map(nameOf), ["E♭", "D♯"]);
  assertEquals(minor[8].spellings.map(nameOf), ["G♯", "A♭"]);
  for (const type of SCALE_TYPES) {
    for (const o of tonicOptions(type)) {
      assert(o.spellings.length >= 1, `${type} pc ${o.pc} has no spelling`);
    }
  }
});

Deno.test("octaves out of range are refused", () => {
  assertThrows(() =>
    buildSteps({
      tonic: P("C"),
      type: "major",
      octaves: 5,
      direction: "up",
      hands: "rh",
    })
  );
  assertThrows(() =>
    buildSteps({
      tonic: P("C"),
      type: "major",
      octaves: 0,
      direction: "up",
      hands: "rh",
    })
  );
});

Deno.test("titles", () => {
  assertEquals(scaleTitle(P("D"), "harmonic-minor"), "D harmonic minor");
  assertEquals(scaleTitle(P("Eb"), "major"), "E♭ major");
  assertEquals(scaleTitle(P("A"), "natural-minor"), "A natural minor");
});
