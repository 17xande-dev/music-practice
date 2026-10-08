// Parity fixtures for the Swift port (ScoreKit / MusicCore): what the web
// app's OSMD walk produces for a set of MusicXML files, and what the pure
// score layer (score.ts, song_player.ts) makes of it.
//
//   deno task score-fixtures
//
// OSMD runs headless under jsdom, with a stub canvas (layout is irrelevant
// to the walk, but OSMD measures text while rendering and needs a canvas).
// Writes frontend/lib/testdata/fixtures/<name>.walk.json and .score.json;
// see the README there for the formats.

// Imported here, not through the import map, so frontend code cannot use it.
import { JSDOM } from "npm:jsdom@30.1.2";
import { fileURLToPath } from "node:url";
import {
  buildScore,
  chooseParts,
  measureStarts,
  measureStats,
  type Practice,
  practiceSteps,
  type RawEntry,
  type Score,
  type Selection,
  stepOffsets,
  weakestRange,
} from "../frontend/lib/score.ts";
import { playPlan } from "../frontend/lib/song_player.ts";
import { walkCursor } from "../frontend/lib/score_walk.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = `${ROOT}frontend/lib/testdata/fixtures`;
const INPUTS = [
  ...[...Deno.readDirSync(`${ROOT}internal/handler/static/songs`)].map((e) => ({
    dir: `${ROOT}internal/handler/static/songs`,
    file: e.name,
  })),
  ...[...Deno.readDirSync(`${ROOT}frontend/lib/testdata/edge`)].map((e) => ({
    dir: `${ROOT}frontend/lib/testdata/edge`,
    file: e.name,
  })),
]
  .filter((f) => /\.(musicxml|mxl)$/.test(f.file))
  .sort((a, b) => a.file.localeCompare(b.file));

// ---- headless OSMD ---------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
const win = dom.window as unknown as Record<string, unknown>;
for (const k of ["window", "document", "DOMParser", "XMLSerializer", "Node", "HTMLElement"]) {
  g[k] = k === "window" ? dom.window : win[k];
}
// OSMD measures text on a canvas while laying out; a fixed width will do.
dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
  font: "",
  measureText: (t: string) => ({ width: t.length * 5, actualBoundingBoxAscent: 5 }),
})) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

// OSMD is CommonJS and reads window/document at import, so it comes last.
// Deno hands the CommonJS bundle over as { default: exports }.
const mod = await import("opensheetmusicdisplay") as unknown as {
  default: { OpenSheetMusicDisplay: typeof import("opensheetmusicdisplay").OpenSheetMusicDisplay };
};
const { OpenSheetMusicDisplay } = mod.default;

async function walkFile(path: string) {
  const bytes = Deno.readFileSync(path);
  let content: string;
  if (path.endsWith(".mxl")) {
    // As ScoreView.load: OSMD unzips a binary string itself.
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    content = bin;
  } else content = new TextDecoder().decode(bytes);
  const div = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(div);
  // The same options as ScoreView (score_view.ts).
  const osmd = new OpenSheetMusicDisplay(div, {
    backend: "svg",
    autoResize: false,
    followCursor: false,
    drawTitle: false,
    drawComposer: false,
    drawCredits: false,
    drawPartNames: false,
  });
  osmd.EngravingRules.RenderFingerings = false;
  osmd.setLogLevel("error"); // the stub canvas makes layout complain
  await osmd.load(content);
  osmd.setOptions({ defaultColorMusic: "currentColor" });
  osmd.render();
  const parts = (osmd.Sheet.Instruments as unknown as { Name?: string; Staves: unknown[] }[])
    .map((i) => ({ name: i.Name ?? "", staves: i.Staves.length }));
  let ref = 0;
  const entries = walkCursor(osmd, () => ref++);
  return { parts, entries, title: osmd.Sheet.TitleString?.trim() ?? "" };
}

// ---- fixtures --------------------------------------------------------------

/** The walk, without renderer handles, and in a fixed note order. */
function normalise(entries: RawEntry[]): RawEntry[] {
  let ref = 0;
  return entries.map((e) => ({
    ...e,
    notes: [...e.notes]
      .sort((a, b) => a.staff - b.staff || a.midi - b.midi)
      .map((n) => ({ ...n, ref: ref++ })),
  }));
}
const noRef = <T extends { ref?: number }>(n: T): Omit<T, "ref"> => {
  const { ref: _ref, ...rest } = n;
  return rest;
};

/**
 * A fixed fake play-through of a selection's steps, a function of the step
 * index i alone, so another implementation can reproduce it:
 *   status = "missed" if i % 7 == 3, else "ok"
 *   clean  = status == "ok" && i % 5 != 1
 *   wrong  = [60] if i % 4 == 2, else []
 *   grade  = "early" if i % 6 == 0, "late" if i % 6 == 4, else null
 */
function syntheticResults(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const status = i % 7 === 3 ? "missed" : "ok";
    return {
      status,
      clean: status === "ok" && i % 5 !== 1,
      wrong: i % 4 === 2 ? [60] : [],
      grade: i % 6 === 0 ? "early" : i % 6 === 4 ? "late" : null,
    };
  });
}

function scoreFixture(score: Score) {
  const hands = ["both", "rh", "lh"] as const;
  const ranges: { name: string; from?: number; to?: number }[] = [
    { name: "all" },
    { name: "m2-3", from: 2, to: 3 },
  ];
  const practice: Record<string, unknown> = {};
  for (const hand of hands) {
    for (const r of ranges) {
      const sel: Selection = { hands: hand, from: r.from, to: r.to };
      const p: Practice = practiceSteps(score, sel);
      const results = syntheticResults(p.steps.length);
      const stats = measureStats(p, results);
      const plan = (o: Parameters<typeof playPlan>[2]) => ({
        opts: o,
        plan: playPlan(score, p, o),
      });
      practice[`${hand}/${r.name}`] = {
        selection: sel,
        steps: p.steps,
        beats: p.beats,
        eventIndices: p.events.map((e) => e.index),
        accompaniment: p.accompaniment,
        all: p.all,
        startBeat: p.startBeat,
        measureStarts: measureStarts(p),
        offsets: { "100": stepOffsets(score, p, 100), "75": stepOffsets(score, p, 75) },
        plans: [
          plan({ pct: 100, metronome: true, notes: "other", countIn: true }),
          plan({ pct: 75, metronome: true, notes: "other", countIn: true }),
          plan({ pct: 100, metronome: false, notes: "all", countIn: false }),
          plan({ pct: 75, metronome: false, notes: "all", countIn: false }),
        ],
        stats,
        weakest: { span2: weakestRange(stats), span3: weakestRange(stats, 3) },
      };
    }
  }
  return {
    score: {
      ...score,
      events: score.events.map((e) => ({ ...e, notes: e.notes.map(noRef) })),
    },
    practice,
  };
}

const write = (name: string, v: unknown) =>
  Deno.writeTextFileSync(`${OUT}/${name}`, JSON.stringify(v, null, 1) + "\n");

// Stale outputs (a removed or renamed input) must not linger.
Deno.mkdirSync(OUT, { recursive: true });
for (const e of Deno.readDirSync(OUT)) {
  if (/\.(walk|score)\.json$/.test(e.name)) Deno.removeSync(`${OUT}/${e.name}`);
}
const seen = new Set<string>();
for (const f of INPUTS) {
  const name = f.file.replace(/\.(musicxml|mxl)$/, "");
  const label = f.file.endsWith(".mxl") ? `${name}.mxl` : name;
  const { parts, entries, title } = await walkFile(`${f.dir}/${f.file}`);
  const walk = normalise(entries);
  const fileName = f.file.endsWith(".mxl") ? `${name}-mxl` : name;
  if (seen.has(fileName)) throw new Error(`duplicate fixture name: ${fileName}`);
  seen.add(fileName);
  write(`${fileName}.walk.json`, {
    source: f.file,
    title,
    parts,
    chosen: chooseParts(parts),
    entries: walk.map((e) => ({ ...e, notes: e.notes.map(noRef) })),
  });
  // The score layer sees the normalised walk, refs and all (refs are not written).
  write(`${fileName}.score.json`, scoreFixture(buildScore(walk)));
  console.log(`${label}: ${walk.length} entries`);
}
