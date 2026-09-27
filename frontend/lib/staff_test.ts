import { assertEquals } from "@std/assert";
import { clefFor, keySpec, notesPerLine, vfKey } from "./staff_view.ts";

Deno.test("VexFlow key strings carry the spelling", () => {
  assertEquals(vfKey({ letter: "F", acc: 1, octave: 4 }), "f#/4");
  assertEquals(vfKey({ letter: "B", acc: -1, octave: 3 }), "bb/3");
  assertEquals(vfKey({ letter: "F", acc: 2, octave: 5 }), "f##/5");
  assertEquals(vfKey({ letter: "C", acc: 0, octave: 4 }), "c/4");
});

Deno.test("key signatures by circle-of-fifths position", () => {
  assertEquals(keySpec(0), "C");
  assertEquals(keySpec(2), "D");
  assertEquals(keySpec(-3), "Eb");
  assertEquals(keySpec(7), "C#");
  assertEquals(keySpec(-7), "Cb");
  assertEquals(keySpec(null), "C"); // blues and chromatic: accidentals only
});

Deno.test("each hand keeps its home clef unless well out of range", () => {
  const around = (m: number) => [m - 2, m, m + 2];
  assertEquals(clefFor(around(60), "rh"), "treble");
  assertEquals(clefFor(around(60), "lh"), "bass"); // middle C: no needless flip
  assertEquals(clefFor(around(48), "rh"), "bass");
  assertEquals(clefFor([52, 54, 56, 57, 59, 61], "rh"), "bass"); // E3–C♯4: fewer ledger lines
  assertEquals(clefFor(around(72), "lh"), "treble");
});

Deno.test("notes per line fit the width, within bounds", () => {
  assertEquals(notesPerLine(320), 6);
  assertEquals(notesPerLine(800), 15);
  assertEquals(notesPerLine(3000), 16);
});
