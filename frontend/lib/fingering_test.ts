import { assert, assertEquals } from "@std/assert";
import { guitarFinger, guitarFingering, pianoFingering, scalePattern } from "./fingering.ts";
import { boxFor, layout, tonicMidiFor } from "./guitar.ts";
import {
  buildSteps,
  type ExerciseOptions,
  type PitchName,
  SCALE_TYPES,
  SCALES,
  type ScaleType,
  tonicOptions,
} from "./theory.ts";

const P = (s: string): PitchName => ({
  letter: s[0] as PitchName["letter"],
  acc: { "": 0, "#": 1, "b": -1 }[s.slice(1)]!,
});

function fingers(
  tonic: string,
  type: ScaleType,
  hands: ExerciseOptions["hands"],
  octaves = 1,
  direction: ExerciseOptions["direction"] = "up",
): string {
  const steps = buildSteps({ tonic: P(tonic), type, octaves, direction, hands });
  return pianoFingering(steps).map((f) => f.join("")).join(hands === "both" ? " " : "");
}

// One octave up, as the standard scale books give them (Alfred's Complete
// Book of Scales, pianoscales.org). B♭ in the right hand starts on 2, with
// 4 on every B♭ after the first.
const MAJOR_RH: Record<string, string> = {
  C: "12312345",
  G: "12312345",
  D: "12312345",
  A: "12312345",
  E: "12312345",
  B: "12312345",
  "F#": "23412312",
  Gb: "23412312",
  Db: "23123412",
  "C#": "23123412",
  Ab: "34123123",
  Eb: "31234123",
  Bb: "21231234",
  F: "12341234",
  Cb: "12312345",
};
const MAJOR_LH: Record<string, string> = {
  C: "54321321",
  G: "54321321",
  D: "54321321",
  A: "54321321",
  E: "54321321",
  B: "43214321",
  "F#": "43213214",
  Gb: "43213214",
  Db: "32143213",
  "C#": "32143213",
  Ab: "32143213",
  Eb: "32143213",
  Bb: "32143213",
  F: "54321321",
  Cb: "43214321",
};
const HARMONIC_RH: Record<string, string> = {
  A: "12312345",
  E: "12312345",
  B: "12312345",
  "F#": "34123123",
  "C#": "34123123",
  "G#": "34123123",
  "D#": "31234123",
  Eb: "31234123",
  Bb: "21231234",
  F: "12341234",
  C: "12312345",
  G: "12312345",
  D: "12312345",
};
const HARMONIC_LH: Record<string, string> = {
  A: "54321321",
  E: "54321321",
  B: "43214321",
  "F#": "43213214",
  "C#": "32143213",
  "G#": "32143213",
  "D#": "21432132",
  Eb: "21432132",
  Bb: "21321432",
  F: "54321321",
  C: "54321321",
  G: "54321321",
  D: "54321321",
};

for (
  const [label, type, table, hands] of [
    ["major RH", "major", MAJOR_RH, "rh"],
    ["major LH", "major", MAJOR_LH, "lh"],
    ["harmonic minor RH", "harmonic-minor", HARMONIC_RH, "rh"],
    ["harmonic minor LH", "harmonic-minor", HARMONIC_LH, "lh"],
  ] as const
) {
  Deno.test(`${label}: the standard fingering in every key`, () => {
    for (const [tonic, want] of Object.entries(table)) {
      assertEquals(fingers(tonic, type, hands), want, `${tonic} ${label}`);
    }
  });
}

Deno.test("more octaves repeat the pattern; only the outer end changes", () => {
  assertEquals(fingers("C", "major", "rh", 2), "123123412312345");
  assertEquals(fingers("C", "major", "lh", 2), "543213214321321");
  assertEquals(fingers("Bb", "major", "rh", 2), "212312341231234");
  assertEquals(fingers("Bb", "major", "rh", 1, "updown"), "212312343213212");
});

Deno.test("coming down retraces the same fingers", () => {
  assertEquals(fingers("C", "major", "rh", 1, "updown"), "123123454321321");
  assertEquals(fingers("C", "major", "lh", 1, "updown"), "543213212312345");
  assertEquals(fingers("E", "major", "lh", 2, "updown"), "54321321432132123123412312345");
});

Deno.test("hands together: each hand keeps its own fingering", () => {
  assertEquals(fingers("D", "major", "both"), "15 24 33 12 21 33 42 51");
});

// Melodic minor descends as the natural minor: different notes, so the
// way down is fingered for those notes.
Deno.test("melodic minor fingers its natural-minor descent", () => {
  assertEquals(fingers("A", "melodic-minor", "rh", 1, "updown"), "123123454321321");
  assertEquals(fingers("A", "melodic-minor", "lh", 1, "updown"), "543213212312345");
});

Deno.test("chromatic: 3 on black keys, 1 on white, 2 where two whites meet", () => {
  assertEquals(fingers("C", "chromatic", "rh"), "1313123131312");
  assertEquals(fingers("C", "chromatic", "lh"), "1313213131321");
});

Deno.test("pentatonic and blues: thumb off black keys, groups of two to four", () => {
  assertEquals(fingers("C", "major-pentatonic", "rh"), "121234");
  assertEquals(fingers("A", "minor-pentatonic", "rh"), "121234");
  assertEquals(fingers("C", "blues", "rh"), "1212345");
});

// Every scale in every key, both hands, any length: a playable fingering.
// Fingers stay in 1–5, neighbouring notes never repeat a finger, and the
// thumb lands on a black key only where white keys can't take every
// crossing: scales with one white key an octave (B major pentatonic) or two
// a semitone apart (B♭ blues: E and F).
Deno.test("every scale in every key gets a playable fingering", () => {
  const BLACK = new Set([1, 3, 6, 8, 10]);
  // Block-chord exercises are checked by the triad test below.
  for (const type of SCALE_TYPES.filter((t) => !SCALES[t].chord)) {
    for (const { spellings } of tonicOptions(type)) {
      for (const tonic of spellings) {
        for (const hands of ["rh", "lh"] as const) {
          for (const octaves of [1, 2, 4]) {
            const steps = buildSteps({ tonic, type, octaves, direction: "updown", hands });
            const f = pianoFingering(steps).map((x) => x[0]!); // piano always fingers every note
            const midis = steps.map((s) => s.notes[0].midi);
            const whites = new Set(midis.filter((m) => !BLACK.has(m % 12)).map((m) => m % 12));
            const [w0, w1] = [...whites].sort((a, b) => a - b);
            const allBlack = whites.size < 2 ||
              (whites.size === 2 && (w1 - w0 === 1 || w1 - w0 === 11));
            f.forEach((x, i) => {
              const where = `${tonic.letter}${tonic.acc} ${type} ${hands} ${octaves} @${i}`;
              assert(x >= 1 && x <= 5, where);
              if (x === 1 && !allBlack) {
                assert(!BLACK.has(midis[i] % 12), `thumb on black ${where}`);
              }
              if (i > 0) {
                assert(x !== f[i - 1], `repeated finger ${where}`);
                assert(Math.abs(x - f[i - 1]) <= 4, where);
              }
            });
          }
        }
      }
    }
  }
});

// F♯ major pentatonic is all black keys. The thumb crosses at the minor
// thirds (A♯–C♯, D♯–F♯), following the keyboard's groups of black keys.
Deno.test("an all-black scale crosses at its wide gaps", () => {
  assertEquals(fingers("F#", "major-pentatonic", "rh"), "123123");
  assertEquals(fingers("F#", "major-pentatonic", "lh"), "321213");
  assertEquals(scalePattern([0, 2, 4, 7, 9], 6, "rh"), [1, 2, 3, 1, 2]);
});

Deno.test("guitar: one finger per fret, index on the position's first fret", () => {
  const box = boxFor(5);
  assertEquals(guitarFinger({ string: 0, fret: 5, inBox: true }, box), 1);
  assertEquals(guitarFinger({ string: 0, fret: 8, inBox: true }, box), 4);
  assertEquals(guitarFinger({ string: 0, fret: 4, inBox: true }, box), 1); // stretch down
  assertEquals(guitarFinger({ string: 0, fret: 9, inBox: true }, box), 4); // stretch up
  const open = boxFor(0);
  assertEquals(guitarFinger({ string: 1, fret: 0, inBox: true }, open), 0);
  assertEquals(guitarFinger({ string: 1, fret: 3, inBox: true }, open), 3);
  // Out of the box: the hand shifts, so no finger is claimed.
  assertEquals(guitarFinger({ string: 5, fret: 8, inBox: false }, open), null);
});

Deno.test("guitar: G major in 2nd position, string by string", () => {
  const box = boxFor(2);
  const steps = buildSteps({
    tonic: P("G"),
    type: "major",
    octaves: 2,
    direction: "up",
    hands: "rh",
    tonicMidi: tonicMidiFor(P("G"), box),
  });
  const places = layout(steps.map((s) => s.notes[0].midi), box);
  const f = guitarFingering(steps, places, box).map((x) => x[0]).join("");
  // E string G3 A5 · A: B2 C3 D5 · D: E2 F♯4 G5 · G: A2 B4 C5 · B: D3 E5 · e: F♯2 G3.
  assertEquals(f, "241241341342412");
});

// Two octaves up, from the arpeggio table (colorinmypiano.com, Joy Morin).
const ARP_RH: Record<string, string> = {
  "C major-arpeggio": "1231235",
  "D major-arpeggio": "1231235",
  "Gb major-arpeggio": "1231235",
  "Eb major-arpeggio": "2124124",
  "Bb major-arpeggio": "2124124",
  "Db major-arpeggio": "2124124",
  "A minor-arpeggio": "1231235",
  "F# minor-arpeggio": "2124124",
  "Bb minor-arpeggio": "2312312",
  "Eb minor-arpeggio": "1231235",
};
const ARP_LH: Record<string, string> = {
  "C major-arpeggio": "5421421",
  "F major-arpeggio": "5421421",
  "E major-arpeggio": "5321321",
  "B major-arpeggio": "5321321",
  "Gb major-arpeggio": "5321321",
  "Ab major-arpeggio": "2142142",
  "G minor-arpeggio": "5421421",
  "C# minor-arpeggio": "2142142",
  "Bb minor-arpeggio": "3213212",
};

Deno.test("arpeggios: the standard fingering in each key group", () => {
  for (const [hands, table] of [["rh", ARP_RH], ["lh", ARP_LH]] as const) {
    for (const [name, want] of Object.entries(table)) {
      const [tonic, type] = name.split(" ");
      assertEquals(fingers(tonic, type as ScaleType, hands, 2), want, `${name} ${hands}`);
    }
  }
});

Deno.test("arpeggios: coming down retraces the fingers", () => {
  assertEquals(fingers("C", "major-arpeggio", "rh", 1, "updown"), "1235321");
  assertEquals(fingers("C", "major-arpeggio", "lh", 1, "updown"), "5421245");
});

Deno.test("triad inversions: 135 / 125 in the right hand, 531 / 521 in the left", () => {
  const steps = buildSteps({
    tonic: P("C"),
    type: "major-inversions",
    octaves: 1,
    direction: "up",
    hands: "both",
  });
  // Root, first inversion, second inversion, root: RH (low to high) then LH.
  assertEquals(steps.map((s) => s.notes.map((n) => n.midi)), [
    [60, 64, 67, 48, 52, 55],
    [64, 67, 72, 52, 55, 60],
    [67, 72, 76, 55, 60, 64],
    [72, 76, 79, 60, 64, 67],
  ]);
  assertEquals(pianoFingering(steps).map((f) => f.join("")), [
    "135531",
    "125531",
    "135521",
    "135531",
  ]);
});
