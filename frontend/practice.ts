// The practice page controller: wires the scale picker, the inputs (Web MIDI
// and the computer keyboard), the grading engine and the views together.

import { type Engine, type NoteEvent, NotesEngine, type Summary } from "./lib/engine.ts";
import { KeyboardView } from "./lib/keyboard_view.ts";
import { ALL_DEVICES, Midi, type MidiDevice, type MidiState } from "./lib/midi.ts";
import { listenQwerty, resolveOctave, Synth } from "./lib/qwerty.ts";
import {
  buildSteps,
  type ExerciseOptions,
  nameOf,
  noteLabel,
  type PitchName,
  SCALE_TYPES,
  SCALES,
  scaleTitle,
  type ScaleType,
  type Step,
  tonicOptions,
} from "./lib/theory.ts";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  form: el<HTMLFormElement>("scale-form"),
  tonic: el<HTMLSelectElement>("tonic"),
  type: el<HTMLSelectElement>("type"),
  hands: el<HTMLSelectElement>("hands"),
  octaves: el<HTMLSelectElement>("octaves"),
  direction: el<HTMLSelectElement>("direction"),
  device: el<HTMLSelectElement>("midi-input"),
  midiStatus: el("midi-status"),
  activity: el("midi-activity"),
  title: el("exercise-title"),
  status: el("exercise-status"),
  restart: el<HTMLButtonElement>("restart"),
  keyboard: el("keyboard"),
  results: el("results"),
  stats: el("results-stats"),
  resultsNote: el("results-note"),
};

const keyboard = new KeyboardView(ui.keyboard);
const synth = new Synth();
const midi = new Midi();

let options: ExerciseOptions;
let steps: Step[] = [];
let engine: Engine;

// ---- Scale picker -------------------------------------------------------

const pitchKey = (p: PitchName) => `${p.letter}${p.acc}`;
const parsePitchKey = (k: string): PitchName => ({
  letter: k[0] as PitchName["letter"],
  acc: Number(k.slice(1)),
});

function populateTypes() {
  ui.type.replaceChildren(
    ...SCALE_TYPES.map((t) => new Option(SCALES[t].label, t)),
  );
}

/**
 * Fill the key select for a scale type. Each pitch class appears once per
 * usable spelling ("C♯ / D♭" become two entries), and the current tonic is
 * kept when the new type still offers it.
 */
function populateTonics(type: ScaleType, keep?: PitchName) {
  const opts = tonicOptions(type).flatMap((o) => o.spellings);
  ui.tonic.replaceChildren(
    ...opts.map((p) => new Option(nameOf(p), pitchKey(p))),
  );
  const want = keep && opts.find((p) => pitchKey(p) === pitchKey(keep));
  ui.tonic.value = pitchKey(want ?? opts[0]);
}

function readOptions(): ExerciseOptions {
  return {
    tonic: parsePitchKey(ui.tonic.value),
    type: ui.type.value as ScaleType,
    octaves: Number(ui.octaves.value),
    direction: ui.direction.value as ExerciseOptions["direction"],
    hands: ui.hands.value as ExerciseOptions["hands"],
  };
}

// ---- Exercise lifecycle ---------------------------------------------------

function rebuild() {
  options = readOptions();
  steps = buildSteps(options);
  ui.title.textContent = scaleTitle(options.tonic, options.type);
  const all = steps.flatMap((s) => s.notes.map((n) => n.midi));
  keyboard.setRange(Math.min(...all), Math.max(...all));
  keyboard.setScale(all);
  reset();
}

function reset() {
  engine = new NotesEngine(steps);
  keyboard.releaseAll();
  ui.results.hidden = true;
  showProgress();
}

function currentStep(): Step | undefined {
  return engine instanceof NotesEngine ? steps[engine.cursor] : undefined;
}

function currentTargets(): number[] {
  return currentStep()?.notes.map((n) => n.midi) ?? [];
}

function showProgress() {
  const step = currentStep();
  keyboard.setTargets(currentTargets());
  if (!step) {
    ui.status.textContent = "Done — press Restart or Space to go again.";
    return;
  }
  const names = step.notes.map((n) =>
    (steps[0].notes.length > 1 ? `${n.hand.toUpperCase()} ` : "") +
    noteLabel(n.spelled)
  );
  const where = engine instanceof NotesEngine && engine.cursor === 0
    ? "Play the first note to begin"
    : `Note ${(engine as NotesEngine).cursor + 1} of ${steps.length}`;
  ui.status.textContent = `${where} · next: ${names.join(" + ")}`;
  keyboard.reveal(step.notes[0].midi);
}

// ---- Input ------------------------------------------------------------------

function handleNote(ev: NoteEvent) {
  if (ev.type === "off") {
    keyboard.release(ev.midi);
    return;
  }
  if (engine.done) {
    keyboard.press(ev.midi, "neutral");
    return;
  }
  const fb = engine.input(ev);
  keyboard.press(
    ev.midi,
    fb.kind === "correct" ? "ok" : fb.kind === "wrong" ? "bad" : "neutral",
  );
  showProgress();
  if (engine.done) showResults(engine.summary());
}

// Which MIDI notes each held computer key produced, so key-up releases the
// same notes even if the target moved while it was held.
const qwertyHeld = new Map<string, number[]>();

listenQwerty((p) => {
  if (!p.down) {
    for (const m of qwertyHeld.get(p.code) ?? []) {
      synth.noteOff(m);
      handleNote({ type: "off", midi: m, velocity: 0, t: p.t });
    }
    qwertyHeld.delete(p.code);
    return;
  }
  const targets = currentTargets();
  let midis = resolveOctave(p.pc, targets);
  // A wrong pitch class is one wrong note, not one per hand.
  if (
    targets.length > 1 && !targets.some((t) => ((t % 12) + 12) % 12 === p.pc)
  ) midis = midis.slice(0, 1);
  qwertyHeld.set(p.code, midis);
  for (const m of midis) {
    synth.noteOn(m);
    handleNote({ type: "on", midi: m, velocity: 90, t: p.t });
  }
});

let activityTimer = 0;
midi.onNote = (ev) => {
  if (ev.type === "on") {
    ui.activity.classList.add("on");
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => ui.activity.classList.remove("on"), 120);
  }
  handleNote(ev);
};

const MIDI_MESSAGES: Record<MidiState, string> = {
  unsupported:
    "This browser has no Web MIDI. Use Chrome, Edge or Firefox to connect an instrument.",
  insecure: "Web MIDI needs a secure (https) connection.",
  denied: "MIDI access was blocked. Allow it in the site settings to use your instrument.",
  ready: "",
};

function showDevices(devices: MidiDevice[]) {
  const prev = ui.device.value;
  if (devices.length === 0) {
    ui.device.replaceChildren(new Option("No MIDI devices connected", ""));
    ui.device.disabled = true;
    ui.midiStatus.textContent =
      "Connect your instrument by USB or Bluetooth MIDI. It will appear here.";
    return;
  }
  const opts = devices.map((d) => new Option(d.name, d.id));
  if (devices.length > 1) opts.unshift(new Option("All devices", ALL_DEVICES));
  ui.device.replaceChildren(...opts);
  ui.device.disabled = false;
  ui.device.value = [...ui.device.options].some((o) => o.value === prev) ? prev : opts[0].value;
  midi.select(ui.device.value);
  ui.midiStatus.textContent = devices.length === 1
    ? `Connected: ${devices[0].name}`
    : `${devices.length} devices`;
}

// ---- Results ----------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One term/value pair, wrapped in a div (valid in a dl) so it is one grid cell. */
function stat(label: string, value: string): HTMLDivElement {
  const div = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

function showResults(s: Summary) {
  const rows = [
    stat("Accuracy", pct(s.accuracy)),
    stat("Clean notes", `${s.correct} of ${s.total}`),
    stat("Wrong notes", String(s.wrongNotes)),
    stat("Time", secs(s.durationMs)),
  ];
  if (s.unevenness !== null) {
    rows.push(stat("Evenness", pct(Math.max(0, 1 - s.unevenness))));
  }
  if (s.velocityStd !== null) {
    rows.push(stat("Dynamics spread", `±${Math.round(s.velocityStd)}`));
  }
  if (steps[0].notes.length > 1) {
    rows.push(stat("Hands apart", `${s.notTogether} of ${s.total}`));
  }
  ui.stats.replaceChildren(...rows);
  ui.resultsNote.textContent = s.accuracy === 1
    ? "A clean run."
    : "Evenness is how steady your note spacing was; dynamics spread is how much your touch varied.";
  ui.results.hidden = false;
}

// ---- Wiring -----------------------------------------------------------------

ui.form.addEventListener("submit", (e) => e.preventDefault());
ui.type.addEventListener("change", () => {
  populateTonics(ui.type.value as ScaleType, parsePitchKey(ui.tonic.value));
  rebuild();
});
for (const s of [ui.tonic, ui.hands, ui.octaves, ui.direction]) {
  s.addEventListener("change", rebuild);
}
ui.device.addEventListener("change", () => midi.select(ui.device.value));
ui.restart.addEventListener("click", () => {
  reset();
  ui.restart.blur();
});
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (
    e.code === "Space" &&
    !["BUTTON", "SELECT", "INPUT", "A"].includes(t.tagName)
  ) {
    e.preventDefault();
    reset();
  }
});

populateTypes();
ui.type.value = "major";
populateTonics("major");
rebuild();

midi.onDevices = showDevices;
// Chrome asks permission for Web MIDI and the promise waits on the prompt,
// so say what it is waiting for rather than "looking" indefinitely.
const promptHint = setTimeout(() => {
  ui.midiStatus.textContent = "Allow MIDI access in your browser's prompt to use your instrument.";
}, 1500);
midi.init().then((state) => {
  clearTimeout(promptHint);
  if (state === "ready") return;
  ui.device.replaceChildren(new Option("MIDI unavailable", ""));
  ui.device.disabled = true;
  ui.midiStatus.textContent = MIDI_MESSAGES[state];
  ui.midiStatus.classList.add("warn");
});

// Test hook: lets browser automation play notes through exactly the path a
// MIDI message takes, since DevTools cannot provide a real MIDI device.
(globalThis as unknown as { __practice: unknown }).__practice = {
  note: (midiNote: number, on = true, t = performance.now()) =>
    midi.onNote({ type: on ? "on" : "off", midi: midiNote, velocity: 80, t }),
  targets: currentTargets,
};
