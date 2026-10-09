import { assert, assertEquals, assertNotEquals } from "@std/assert";

// The larger real scores (frontend/lib/testdata/complex, shared with ScoreKit)
// run through OSMD by `deno task score-fixtures`; these tests read what it
// wrote, so they fail if a fixture was not regenerated after an OSMD bump.

const DIR = new URL("./testdata/fixtures/", import.meta.url);
const SRC = new URL("./testdata/complex/", import.meta.url);

/** Scores OSMD cannot walk, with the recorded error (tools/score_fixtures.ts). */
const EXPECTED_ERRORS: Record<string, string> = {
  "openscore-grandval-les-clochettes": "start index of line is greater than the end index",
  "lilypond-13a-KeySignatures": "Bad key signature spec",
  "lilypond-41h-TooManyParts": "could not be loaded",
};

type Entry = { measure: number; occurrence: number; beat: number; bpm: number; notes: unknown[] };
const read = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, DIR)));

const inputs: string[] = [];
for (const sub of ["openscore", "lilypond"]) {
  for (const e of Deno.readDirSync(new URL(`${sub}/`, SRC))) {
    if (e.name.endsWith(".mxl")) inputs.push(`${sub}-${e.name.replace(/\.mxl$/, "")}`);
  }
}

/** Written measures in played order, consecutive ones joined ("1-37 47-78"). */
function order(entries: Entry[]): string {
  const runs: [number, number][] = [];
  let last = -1;
  for (const e of entries) {
    if (e.occurrence === last) continue;
    last = e.occurrence;
    const r = runs.at(-1);
    if (r && r[1] + 1 === e.measure) r[1] = e.measure;
    else runs.push([e.measure, e.measure]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(" ");
}

Deno.test("complex scores: 25 inputs, each parses and walks (or fails as recorded)", () => {
  assertEquals(inputs.length, 25);
  for (const name of inputs) {
    const walk = read(`${name}.walk.json`);
    if (name in EXPECTED_ERRORS) {
      assert(walk.error.includes(EXPECTED_ERRORS[name]), `${name}: ${walk.error}`);
      continue;
    }
    assertEquals(walk.error, undefined, name);
    const entries: Entry[] = walk.entries;
    assert(entries.length > 0, `${name}: no entries`);
    assert(entries.every((e) => e.bpm > 0), `${name}: a zero tempo reached the walk`);
    for (let i = 1; i < entries.length; i++) {
      assert(entries[i].beat >= entries[i - 1].beat, `${name}: beats go backwards at ${i}`);
    }
    const { score, practice } = read(`${name}.score.json`);
    assert(score.tempo.every((t: { bpm: number }) => t.bpm > 0), `${name}: tempo`);
    assert(score.events.length > 0 || name.startsWith("lilypond-"), `${name}: no events`);
    assert(practice["both/all"], `${name}: no practice`);
  }
});

Deno.test("complex scores: a licence and SOURCES.txt sit beside each folder", () => {
  for (const sub of ["openscore", "lilypond"]) {
    for (const f of ["LICENSE", "SOURCES.txt"]) {
      assert(Deno.statSync(new URL(`${sub}/${f}`, SRC)).isFile, `${sub}/${f}`);
    }
  }
});

Deno.test("Satie: known divergence, OSMD's walk is not the intended order", () => {
  const intended = "1-37 47-78 6-35 38-39 79-110 6-35 40-46";
  const osmd = order(read("openscore-satie-je-te-veux.walk.json").entries);
  // Pinned for OSMD 2.2.0 (same walk as 2.1.3). If this fails after a bump,
  // check whether OSMD now matches `intended`, and update the divergence docs.
  assertEquals(osmd, "1-78 6-35 38-110");
  assertNotEquals(osmd, intended);
});

Deno.test("Boulanger, Schumann: no repeats, played once through", () => {
  assertEquals(order(read("openscore-boulanger-parfois-je-suis-triste.walk.json").entries), "1-52");
  assertEquals(order(read("openscore-schumann-widmung.walk.json").entries), "1-44");
});

Deno.test("simple repeats and endings from the LilyPond suite are walked", () => {
  assertEquals(order(read("lilypond-45a-SimpleRepeat.walk.json").entries), "1 1-2");
  assertEquals(order(read("lilypond-45b-RepeatWithAlternatives.walk.json").entries), "1-2 1 3-4");
});
