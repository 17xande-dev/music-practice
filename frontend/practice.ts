// The practice page controller: wires the scale picker, the inputs (Web MIDI
// and the computer keyboard), the grading engines, the metronome and the
// views together.
//
// Two modes. Notes-only is always armed: the first correct note starts the
// run and the cursor waits for you. Tempo mode starts with a button (or
// Space), counts in one bar, then moves on with the metronome whether you
// played or not.

import {
  type NoteEvent,
  NotesEngine,
  type StepResult,
  type Summary,
  TempoEngine,
} from "./lib/engine.ts";
import { KeyboardView } from "./lib/keyboard_view.ts";
import { Metronome } from "./lib/metronome.ts";
import { ALL_DEVICES, Midi, type MidiDevice, type MidiState } from "./lib/midi.ts";
import { listenQwerty, resolveOctave, Synth } from "./lib/qwerty.ts";
import { type NoteDuration, StaffView, type StepMark } from "./lib/staff_view.ts";
import {
  buildSteps,
  type ExerciseOptions,
  keySignatureFifths,
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
  mode: el<HTMLSelectElement>("mode"),
  bpm: el<HTMLInputElement>("bpm"),
  subdivision: el<HTMLSelectElement>("subdivision"),
  latency: el<HTMLInputElement>("latency"),
  device: el<HTMLSelectElement>("midi-input"),
  midiStatus: el("midi-status"),
  activity: el("midi-activity"),
  title: el("exercise-title"),
  status: el("exercise-status"),
  start: el<HTMLButtonElement>("start"),
  restart: el<HTMLButtonElement>("restart"),
  keyboard: el("keyboard"),
  staff: el("staff"),
  results: el("results"),
  stats: el("results-stats"),
  resultsNote: el("results-note"),
};

const keyboard = new KeyboardView(ui.keyboard);
const staff = new StaffView(ui.staff);
const synth = new Synth();
const midi = new Midi();
const metronome = new Metronome();

type Mode = "notes" | "tempo";
type TempoPhase = "idle" | "countin" | "playing" | "done";

let options: ExerciseOptions;
let mode: Mode = "notes";
let steps: Step[] = [];
/** Notes-only: always set. Tempo: set from Start until the next reset. */
let engine: NotesEngine | TempoEngine | null = null;
let phase: TempoPhase = "idle";
let countIn: number[] = [];
let frame = 0;
/** The step the tempo view last highlighted as current. */
let shownCurrent = -1;

// ---- Scale picker -------------------------------------------------------

const pitchKey = (p: PitchName) => `${p.letter}${p.acc}`;
const parsePitchKey = (k: string): PitchName => ({
  letter: k[0] as PitchName["letter"],
  acc: Number(k.slice(1)),
});

function populateTypes() {
  ui.type.replaceChildren(...SCALE_TYPES.map((t) => new Option(SCALES[t].label, t)));
}

/**
 * Fill the key select for a scale type. Each pitch class appears once per
 * usable spelling ("C♯ / D♭" become two entries), and the current tonic is
 * kept when the new type still offers it.
 */
function populateTonics(type: ScaleType, keep?: PitchName) {
  const opts = tonicOptions(type).flatMap((o) => o.spellings);
  ui.tonic.replaceChildren(...opts.map((p) => new Option(nameOf(p), pitchKey(p))));
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

/** A number input's value, clamped to its own min/max, or its default. */
function numberFrom(input: HTMLInputElement, fallback: number): number {
  const v = Number(input.value);
  if (!Number.isFinite(v) || input.value === "") return fallback;
  return Math.min(Number(input.max), Math.max(Number(input.min), v));
}

const tempoSettings = () => ({
  bpm: numberFrom(ui.bpm, 80),
  notesPerBeat: Number(ui.subdivision.value),
  latencyMs: numberFrom(ui.latency, 0),
});

const DURATIONS: Record<number, NoteDuration> = { 1: "q", 2: "8", 4: "16" };

// ---- Exercise lifecycle ---------------------------------------------------

function rebuild() {
  options = readOptions();
  mode = ui.mode.value as Mode;
  for (const x of document.querySelectorAll<HTMLElement>(".tempo-only")) {
    x.hidden = mode !== "tempo";
  }
  steps = buildSteps(options);
  ui.title.textContent = scaleTitle(options.tonic, options.type);
  const all = steps.flatMap((s) => s.notes.map((n) => n.midi));
  keyboard.setRange(Math.min(...all), Math.max(...all));
  keyboard.setScale(all);
  // In tempo mode the staff shows the rhythm being asked for.
  const duration = mode === "tempo" ? DURATIONS[tempoSettings().notesPerBeat] : "q";
  staff.render(steps, keySignatureFifths(options.tonic, options.type), duration);
  reset();
}

function reset() {
  metronome.stop();
  cancelAnimationFrame(frame);
  engine = mode === "notes" ? new NotesEngine(steps) : null;
  phase = "idle";
  shownCurrent = -1;
  keyboard.releaseAll();
  staff.clearMarks();
  ui.results.hidden = true;
  ui.start.textContent = "Start";
  showProgress();
}

async function startTempo() {
  reset();
  const t = tempoSettings();
  ui.start.textContent = "Stop";
  const schedule = await metronome.start(t.bpm, t.notesPerBeat, steps.length);
  engine = new TempoEngine(steps, {
    bpm: t.bpm,
    notesPerBeat: t.notesPerBeat,
    startTime: schedule.startTime,
    latencyMs: t.latencyMs,
  });
  countIn = schedule.countIn;
  phase = "countin";
  frame = requestAnimationFrame(tempoFrame);
}

function finishTempo(e: TempoEngine) {
  metronome.stop();
  phase = "done";
  ui.start.textContent = "Start";
  keyboard.setTargets([]);
  ui.status.textContent = "Done — press Start or Space to go again.";
  showResults(e.summary());
}

/** How a finished step is shown on the staff. */
function markFor(r: StepResult): StepMark {
  if (r.status !== "ok" || !r.clean) return "bad";
  if (r.grade === "early") return "early";
  if (r.grade === "late") return "late";
  return "ok";
}

function tempoFrame() {
  const e = engine as TempoEngine;
  const now = performance.now();
  if (phase === "countin") {
    const left = countIn.filter((t) => t > now).length;
    if (now >= e.dueAt(0) - e.interval / 2) {
      phase = "playing";
    } else {
      ui.status.textContent = left > 0 ? `Count-in: ${left}…` : "Go!";
      setCurrent(0);
    }
  }
  if (phase === "playing") {
    for (const i of e.tick(now)) staff.mark(i, markFor(e.results[i]));
    if (e.done) {
      finishTempo(e);
      return;
    }
    const i = Math.max(0, Math.min(steps.length - 1, e.stepAt(now - (e.opts.latencyMs ?? 0))));
    setCurrent(i);
    ui.status.textContent = `Note ${i + 1} of ${steps.length} · ${e.opts.bpm} BPM`;
  }
  frame = requestAnimationFrame(tempoFrame);
}

/** Move the tempo-mode highlight, leaving already-graded steps alone. */
function setCurrent(i: number) {
  if (i === shownCurrent) return;
  const e = engine as TempoEngine;
  if (shownCurrent >= 0 && e.results[shownCurrent].status === "pending") {
    staff.mark(shownCurrent, null);
  }
  shownCurrent = i;
  if (e.results[i].status === "pending") staff.mark(i, "current");
  keyboard.setTargets(steps[i].notes.map((n) => n.midi));
  keyboard.reveal(steps[i].notes[0].midi);
  staff.reveal(i);
}

function currentStep(): Step | undefined {
  if (engine instanceof NotesEngine) return steps[engine.cursor];
  if (engine instanceof TempoEngine) {
    return phase === "done" ? undefined : steps[Math.max(0, shownCurrent)];
  }
  return steps[0]; // tempo, not started: show where it begins
}

function currentTargets(): number[] {
  return currentStep()?.notes.map((n) => n.midi) ?? [];
}

/** Status line and highlights between notes (notes-only), or before Start. */
function showProgress() {
  if (engine instanceof TempoEngine) return; // the animation frame owns the view
  const step = currentStep();
  keyboard.setTargets(currentTargets());
  if (!step) {
    ui.status.textContent = "Done — press Restart or Space to go again.";
    return;
  }
  const names = step.notes.map((n) =>
    (steps[0].notes.length > 1 ? `${n.hand.toUpperCase()} ` : "") + noteLabel(n.spelled)
  );
  const cursor = engine instanceof NotesEngine ? engine.cursor : 0;
  const where = mode === "tempo"
    ? "Press Start (or Space) for a one-bar count-in"
    : cursor === 0
    ? "Play the first note to begin"
    : `Note ${cursor + 1} of ${steps.length}`;
  ui.status.textContent = `${where} · ${cursor === 0 ? "first" : "next"}: ${names.join(" + ")}`;
  keyboard.reveal(step.notes[0].midi);
  staff.mark(step.index, "current");
  staff.reveal(step.index);
}

// ---- Input ------------------------------------------------------------------

function handleNote(ev: NoteEvent) {
  if (ev.type === "off") {
    keyboard.release(ev.midi);
    return;
  }
  const grading = engine && !engine.done &&
    (mode === "notes" || phase === "countin" || phase === "playing");
  if (!grading) {
    keyboard.press(ev.midi, "neutral");
    return;
  }
  const fb = engine!.input(ev);
  keyboard.press(ev.midi, fb.kind === "correct" ? "ok" : fb.kind === "wrong" ? "bad" : "neutral");
  if (fb.kind === "correct" && fb.stepDone) {
    const r = engine!.results[fb.step];
    // Notes-only: green only for a step played without a wrong note on the
    // way. Tempo: coloured by timing, final when its window closes.
    staff.mark(fb.step, engine instanceof TempoEngine ? markFor(r) : r.clean ? "ok" : "bad");
  }
  if (engine instanceof NotesEngine) {
    showProgress();
    if (engine.done) showResults(engine.summary());
  }
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
  if (targets.length > 1 && !targets.some((t) => ((t % 12) + 12) % 12 === p.pc)) {
    midis = midis.slice(0, 1);
  }
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
  ];
  const t = s.timing;
  if (t) {
    rows.push(
      stat("On the beat", `${t.onTime} of ${s.total}`),
      stat("Early / late", `${t.early} / ${t.late}`),
      stat("Missed", String(t.missed)),
    );
    if (t.meanAbsMs !== null) rows.push(stat("Average offset", `${Math.round(t.meanAbsMs)} ms`));
  } else {
    rows.push(stat("Time", secs(s.durationMs)));
    if (s.unevenness !== null) rows.push(stat("Evenness", pct(Math.max(0, 1 - s.unevenness))));
  }
  if (s.velocityStd !== null) rows.push(stat("Dynamics spread", `±${Math.round(s.velocityStd)}`));
  if (steps[0].notes.length > 1) rows.push(stat("Hands apart", `${s.notTogether} of ${s.total}`));
  ui.stats.replaceChildren(...rows);
  ui.resultsNote.textContent = resultsNote(s);
  ui.results.hidden = false;
}

function resultsNote(s: Summary): string {
  const t = s.timing;
  if (t && t.meanSignedMs !== null && Math.abs(t.meanSignedMs) > t.toleranceMs / 2) {
    const ms = Math.round(Math.abs(t.meanSignedMs));
    return t.meanSignedMs < 0
      ? `You tended to rush, about ${ms} ms ahead of the click.`
      : `You tended to drag, about ${ms} ms behind the click. If it felt on time, try raising the latency offset.`;
  }
  if (s.accuracy === 1) return "A clean run.";
  if (t) return `On the beat means within ±${Math.round(t.toleranceMs)} ms of the click.`;
  return "Evenness is how steady your note spacing was; dynamics spread is how much your touch varied.";
}

// ---- Wiring -----------------------------------------------------------------

function toggleTempo() {
  if (phase === "countin" || phase === "playing") reset();
  else void startTempo();
}

ui.form.addEventListener("submit", (e) => e.preventDefault());
ui.type.addEventListener("change", () => {
  populateTonics(ui.type.value as ScaleType, parsePitchKey(ui.tonic.value));
  rebuild();
});
for (const s of [ui.tonic, ui.hands, ui.octaves, ui.direction, ui.mode, ui.subdivision]) {
  s.addEventListener("change", rebuild);
}
// BPM and latency are read at Start, so editing them needs no rebuild —
// but it does end a run in progress, whose timing no longer matches.
for (const s of [ui.bpm, ui.latency]) s.addEventListener("change", reset);
ui.device.addEventListener("change", () => midi.select(ui.device.value));
ui.start.addEventListener("click", () => {
  toggleTempo();
  ui.start.blur();
});
ui.restart.addEventListener("click", () => {
  reset();
  ui.restart.blur();
});
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (e.code !== "Space" || ["BUTTON", "SELECT", "INPUT", "A"].includes(t.tagName)) return;
  e.preventDefault();
  if (mode === "tempo") toggleTempo();
  else reset();
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
  engine: () => engine,
};
