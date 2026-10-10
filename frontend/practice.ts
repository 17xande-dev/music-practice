// The practice page controller: wires the scale picker, the inputs (Web MIDI,
// guitar audio, and the computer keyboard), the grading engines, the
// metronome and the views together.
//
// Two instruments. Piano reads MIDI and shows a keyboard. Guitar reads an
// audio interface, detects the notes from the sound, and shows a fretboard
// with the chosen position; both feed the same NoteEvents to the same
// engines.
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
import { AudioInput, type AudioState, type Reading } from "./lib/audio_input.ts";
import { type Fingers, guitarFingering, pianoFingering } from "./lib/fingering.ts";
import { FretboardView } from "./lib/fretboard_view.ts";
import { boxFor, layout, positionLabel, POSITIONS, tonicMidiFor } from "./lib/guitar.ts";
import { KeyboardView } from "./lib/keyboard_view.ts";
import { nextKeys, restartsOnNote } from "./lib/practice_flow.ts";
import { pluck, pluckSequence } from "./lib/pluck.ts";
import {
  againstString,
  DEFAULT_A4,
  MAX_A4,
  MIN_A4,
  nearestString,
  tuneAdvice,
  TunerSmoother,
  tuneState,
} from "./lib/tuner.ts";
import { Metronome } from "./lib/metronome.ts";
import { Calibration, describeLatency } from "./lib/calibration.ts";
import { ALL_DEVICES, Midi, type MidiDevice, type MidiState } from "./lib/midi.ts";
import { formatDuration, LearnClock } from "./lib/learn_log.ts";
import {
  better,
  type Instrument,
  ProgressStore,
  scaleKey,
  type Session,
} from "./lib/progress_store.ts";
import { listenQwerty, resolveOctave, Synth } from "./lib/qwerty.ts";
import { fromQuery, toQuery } from "./lib/share_url.ts";
import { type NoteDuration, StaffView, type StepMark } from "./lib/staff_view.ts";
import { renderTimingChart } from "./lib/timing_chart.ts";
import { CircleView } from "./lib/circle_view.ts";
import {
  buildSteps,
  type ExerciseOptions,
  type Family,
  familyOf,
  inFamily,
  keySignatureFifths,
  nameOf,
  noteLabel,
  type PitchName,
  resolveTonic,
  SCALES,
  scaleTitle,
  type ScaleType,
  type Step,
  VARIANTS,
} from "./lib/theory.ts";

import type { Command } from "./lib/commands.ts";
import { installCommands } from "./lib/palette.ts";
import { setPlaying } from "./lib/transport.ts";
import { checkStoredData } from "./lib/data_repair.ts";
import { registerServiceWorker } from "./lib/pwa.ts";
import { siteCommands } from "./lib/site_commands.ts";
import { installSync } from "./lib/sync_triggers.ts";
import { sheetThemeToggle } from "./lib/sheet_theme.ts";

registerServiceWorker();
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  form: el<HTMLFormElement>("scale-form"),
  circle: el("circle"),
  variants: el<HTMLFieldSetElement>("variants"),
  hands: el<HTMLSelectElement>("hands"),
  instrument: el<HTMLSelectElement>("instrument"),
  position: el<HTMLSelectElement>("position"),
  audioField: el("audio-field"),
  audioInput: el<HTMLSelectElement>("audio-input"),
  tunerNote: el("tuner-note"),
  tunerCents: el("tuner-cents"),
  level: el<HTMLMeterElement>("level"),
  fretboard: el("fretboard"),
  tunerOpen: el<HTMLButtonElement>("tuner-open"),
  tunerPanel: el("tuner-panel"),
  tunerClose: el<HTMLButtonElement>("tuner-close"),
  tunerStrings: el("tuner-strings"),
  tunerBig: el("tuner-big"),
  tunerHz: el("tuner-hz"),
  tunerGauge: el("tuner-gauge"),
  tunerAdvice: el("tuner-advice"),
  a4: el<HTMLInputElement>("a4"),
  octaves: el<HTMLSelectElement>("octaves"),
  direction: el<HTMLSelectElement>("direction"),
  mode: el<HTMLSelectElement>("mode"),
  bpm: el<HTMLInputElement>("bpm"),
  subdivision: el<HTMLSelectElement>("subdivision"),
  latency: el<HTMLInputElement>("latency"),
  calibrate: el<HTMLButtonElement>("calibrate"),
  calibrateStatus: el("calibrate-status"),
  fingering: el<HTMLInputElement>("fingering"),
  device: el<HTMLSelectElement>("midi-input"),
  midiStatus: el("midi-status"),
  activity: el("midi-activity"),
  title: el("exercise-title"),
  status: el("exercise-status"),
  start: el<HTMLButtonElement>("start"),
  restart: el<HTMLButtonElement>("restart"),
  copyLink: el<HTMLButtonElement>("copy-link"),
  keyboard: el("keyboard"),
  staff: el("staff"),
  results: el("results"),
  resultsTitle: el("results-title"),
  stats: el("results-stats"),
  timingChart: el("timing-chart"),
  resultsNote: el("results-note"),
  best: el("results-best"),
  storageWarning: el("storage-warning"),
};

const keyboard = new KeyboardView(ui.keyboard);
const fretboard = new FretboardView(ui.fretboard);
const audio = new AudioInput(ui.audioField.dataset.worklet!);
let instrument: Instrument = "piano";
/** Whichever instrument view is showing; both take the same calls. */
let view: KeyboardView | FretboardView = keyboard;
const staff = new StaffView(ui.staff);
const synth = new Synth();
const midi = new Midi();
const metronome = new Metronome();
const calibration = new Calibration(metronome);
const store = ProgressStore.fromWindow();
void checkStoredData(store);
const syncer = installSync(store);

/** Learn waits like notes-only, with hints, and keeps out of the graded history. */
type Mode = "notes" | "tempo" | "learn";
type TempoPhase = "idle" | "countin" | "playing" | "done";

let options: ExerciseOptions;
let mode: Mode = "notes";
let steps: Step[] = [];
/** The finger for each note of each step, shaped like `steps`. */
let fingers: Fingers = [];
/** Guitar dot labels: note names, and finger numbers for when they're shown. */
let dotLabels = { names: new Map<number, string>(), fingers: new Map<number, string>() };
/** Notes-only: always set. Tempo: set from Start until the next reset. */
let engine: NotesEngine | TempoEngine | null = null;
let phase: TempoPhase = "idle";
let countIn: number[] = [];
let frame = 0;
/** The step the tempo view last highlighted as current. */
let shownCurrent = -1;
/** Learn mode: active time on the pass in progress. */
let clock = new LearnClock();

// ---- Scale picker -------------------------------------------------------

// The key is picked on the circle of fifths (tonic + ring), the scale from
// the ring's variant list. `ring` is kept separately from the type's family
// because chromatic belongs to both rings and stays on whichever was tapped.
let pick: { tonic: PitchName; type: ScaleType; ring: Family } = {
  tonic: { letter: "C", acc: 0 },
  type: "major",
  ring: "major",
};

const circle = new CircleView(ui.circle);

/** Short variant names: "Major (Ionian)" reads as just "Major" in the list. */
const variantLabel = (t: ScaleType) => SCALES[t].label.replace(/ \(.*\)$/, "");

/** Draw the circle's selection and the current ring's variant list. */
function renderPicker() {
  circle.render(
    pick.tonic,
    pick.ring,
    scaleTitle(pick.tonic, pick.type),
    keySignatureFifths(pick.tonic, pick.type),
  );
  if (ui.variants.dataset.ring !== pick.ring) {
    // Real radio inputs: keyboard-native, and their change events reach the
    // form, which persists settings.
    const items = VARIANTS[pick.ring].map((t) => {
      const label = document.createElement("label");
      label.className = "variant";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "variant";
      input.value = t;
      const span = document.createElement("span");
      span.textContent = variantLabel(t);
      label.append(input, span);
      return label;
    });
    ui.variants.replaceChildren(ui.variants.querySelector("legend")!, ...items);
    ui.variants.dataset.ring = pick.ring;
  }
  for (const input of ui.variants.querySelectorAll<HTMLInputElement>("input")) {
    input.checked = input.value === pick.type;
    // Guitar's pitch tracker hears one note at a time, so no chord drills.
    const chord = !!SCALES[input.value as ScaleType].chord;
    input.disabled = chord && instrument === "guitar";
    input.parentElement!.title = input.disabled ? "Chords can't be graded on guitar" : "";
  }
}

/**
 * A tap on the circle: keep the current scale if it belongs to the tapped
 * ring, otherwise switch to that ring's default (Major or Natural minor).
 */
circle.onSelect = ({ tonic, ring }) => {
  const type = inFamily(pick.type, ring) ? pick.type : VARIANTS[ring][0];
  pick = { tonic: resolveTonic(tonic, type), type, ring };
  renderPicker();
  rebuild();
  // Circle taps are not form inputs, so no change event persists them.
  persistSettings();
};

function readOptions(): ExerciseOptions {
  const base: ExerciseOptions = {
    tonic: pick.tonic,
    type: pick.type,
    octaves: Number(ui.octaves.value),
    direction: ui.direction.value as ExerciseOptions["direction"],
    hands: ui.hands.value as ExerciseOptions["hands"],
  };
  if (instrument !== "guitar") return base;
  // Guitar: one line, at most two octaves (what a position spans), starting
  // where the chosen position puts the tonic.
  return {
    ...base,
    hands: "rh",
    octaves: Math.min(base.octaves, 2),
    tonicMidi: tonicMidiFor(pick.tonic, boxFor(Number(ui.position.value))),
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

// ---- Remembered settings ------------------------------------------------------

/**
 * Put the last-used choices back into the form (each is validated on
 * read), with anything a shared link specifies taking precedence.
 */
function restoreSettings() {
  const saved = { ...store.settings(), ...fromQuery(location.search) };
  const type = saved.type ?? "major";
  pick = {
    type,
    ring: familyOf(type),
    tonic: resolveTonic(saved.tonic ?? { letter: "C", acc: 0 }, type),
  };
  if (saved.hands) ui.hands.value = saved.hands;
  if (saved.octaves) ui.octaves.value = String(saved.octaves);
  if (saved.direction) ui.direction.value = saved.direction;
  if (saved.mode) ui.mode.value = saved.mode;
  if (saved.bpm) ui.bpm.value = String(saved.bpm);
  if (saved.notesPerBeat) ui.subdivision.value = String(saved.notesPerBeat);
  if (saved.latencyMs !== undefined) ui.latency.value = String(saved.latencyMs);
  if (saved.position !== undefined) ui.position.value = String(saved.position);
  if (saved.fingering !== undefined) ui.fingering.checked = saved.fingering;
  setReference(saved.a4 ?? DEFAULT_A4);
  ui.instrument.value = saved.instrument ?? "piano";
}

function persistSettings() {
  const o = readOptions();
  const t = tempoSettings();
  store.saveSettings({
    tonic: o.tonic,
    type: o.type,
    hands: o.hands,
    octaves: o.octaves,
    direction: o.direction,
    mode: ui.mode.value as Mode,
    bpm: t.bpm,
    notesPerBeat: t.notesPerBeat,
    latencyMs: t.latencyMs,
    instrument,
    position: Number(ui.position.value),
    a4,
    fingering: ui.fingering.checked,
  });
  syncUrl();
}

/**
 * Keep the address bar describing the exercise on screen, so copying the
 * URL shares it. replaceState: changing an option isn't a page to go back to.
 */
function syncUrl() {
  const o = readOptions();
  const t = tempoSettings();
  const query = toQuery({
    instrument,
    tonic: o.tonic,
    type: o.type,
    hands: ui.hands.value as ExerciseOptions["hands"],
    octaves: Number(ui.octaves.value),
    direction: o.direction,
    mode: ui.mode.value as Mode,
    bpm: t.bpm,
    notesPerBeat: t.notesPerBeat,
    position: Number(ui.position.value),
    fingering: ui.fingering.checked,
  });
  history.replaceState(history.state, "", `${location.pathname}?${query}`);
}

let copiedTimer = 0;
async function copyLink() {
  syncUrl();
  let copied = false;
  try {
    await navigator.clipboard.writeText(location.href);
    copied = true;
  } catch {
    // Clipboard blocked (permissions, an insecure origin): the address
    // bar already holds the link, so point there instead.
  }
  ui.copyLink.textContent = copied ? "Link copied" : "Copy the address bar";
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (ui.copyLink.textContent = "Copy link"), 2000);
}

function rebuild() {
  logLearn(false); // before the options change under it
  options = readOptions();
  mode = ui.mode.value as Mode;
  for (const x of document.querySelectorAll<HTMLElement>(".tempo-only")) {
    x.hidden = mode !== "tempo";
  }
  steps = buildSteps(options);
  ui.title.textContent = scaleTitle(options.tonic, options.type);
  const all = steps.flatMap((s) => s.notes.map((n) => n.midi));
  if (instrument === "guitar") {
    const box = boxFor(Number(ui.position.value));
    const places = layout(all, box);
    fingers = guitarFingering(steps, places, box);
    const notes = steps.flatMap((s, i) => s.notes.map((n, h) => ({ n, f: fingers[i][h] })));
    dotLabels = {
      names: new Map(notes.map(({ n }) => [n.midi, nameOf(n.spelled)])),
      fingers: new Map(notes.map(({ n, f }) => [n.midi, f === null ? "" : String(f)])),
    };
    fretboard.setLayout(box, places, showingFingers() ? dotLabels.fingers : dotLabels.names);
  } else {
    fingers = pianoFingering(steps);
    keyboard.setRange(Math.min(...all), Math.max(...all));
    keyboard.setScale(all);
  }
  // In tempo mode the staff shows the rhythm being asked for.
  staff.render(steps, keySignatureFifths(options.tonic, options.type), {
    duration: mode === "tempo" ? DURATIONS[tempoSettings().notesPerBeat] : "q",
    guitar: instrument === "guitar",
    fingers: showingFingers() ? fingers : null,
  });
  reset();
}

/** Learn mode shows fingers whatever the switch says: they're part of learning it. */
function showingFingers(): boolean {
  return ui.fingering.checked || mode === "learn";
}

/**
 * Show or hide finger numbers without restarting: switching them on halfway
 * through a scale is exactly when someone wants them.
 */
function applyFingering() {
  staff.setFingers(showingFingers() ? fingers : null);
  if (instrument === "guitar") {
    fretboard.setLabels(showingFingers() ? dotLabels.fingers : dotLabels.names);
  }
  showTargets(currentStep());
}

/** Highlight a step's notes as the next to play, with fingers if shown. */
function showTargets(step: Step | undefined) {
  if (!step) {
    view.setTargets([]);
    keyboard.setNext([]);
    return;
  }
  view.setTargets(
    step.notes.map((n) => n.midi),
    showingFingers() ? fingers[step.index] : undefined,
  );
  keyboard.setNext(nextKeys(steps, step.index));
}

function reset() {
  logLearn(false);
  metronome.stop();
  cancelAnimationFrame(frame);
  engine = mode === "tempo" ? null : new NotesEngine(steps);
  phase = "idle";
  shownCurrent = -1;
  view.releaseAll();
  staff.clearMarks();
  ui.results.hidden = true;
  setPlaying(ui.start, false);
  showProgress();
}

async function startTempo() {
  reset();
  const t = tempoSettings();
  setPlaying(ui.start, true);
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
  setPlaying(ui.start, false);
  view.setTargets([]);
  keyboard.setNext([]);
  ui.status.textContent = "Done — press Start or Space to go again.";
  finishRun(e.summary());
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
  showTargets(steps[i]);
  view.reveal(steps[i].notes[0].midi);
  staff.reveal(i);
}

function currentStep(): Step | undefined {
  if (engine instanceof NotesEngine) return steps[engine.cursor];
  if (engine instanceof TempoEngine) {
    return phase === "done" ? undefined : steps[Math.max(0, shownCurrent)];
  }
  return steps[0]; // tempo, not started: show where it begins
}

/** A Notes or Learn run that has finished: a note restarts it (Tempo needs its count-in). */
const finishedRun = () => engine instanceof NotesEngine && engine.done;

function currentTargets(): number[] {
  // After a finished run the next note is step 0 of the new one.
  const step = finishedRun() ? steps[0] : currentStep();
  return step?.notes.map((n) => n.midi) ?? [];
}

/** Status line and highlights between notes (notes-only), or before Start. */
function showProgress() {
  if (engine instanceof TempoEngine) return; // the animation frame owns the view
  const step = currentStep();
  showTargets(step);
  if (!step) {
    ui.status.textContent = "Done — play a note or press Restart or Space to go again.";
    return;
  }
  // "RH E♭4 G4 B♭4 + LH E♭3 G3 B♭3": one group per hand.
  const names = (["rh", "lh"] as const)
    .map((hand) => {
      const notes = step.notes.filter((n) => n.hand === hand).map((n) => noteLabel(n.spelled));
      if (!notes.length) return "";
      return (options.hands === "both" ? `${hand.toUpperCase()} ` : "") + notes.join(" ");
    })
    .filter(Boolean);
  const cursor = engine instanceof NotesEngine ? engine.cursor : 0;
  const where = mode === "tempo"
    ? "Press Start (or Space) for a one-bar count-in"
    : cursor === 0
    ? "Play the first note to begin"
    : `Note ${cursor + 1} of ${steps.length}`;
  ui.status.textContent = `${where} · ${cursor === 0 ? "first" : "next"}: ${names.join(" + ")}`;
  view.reveal(step.notes[0].midi);
  staff.mark(step.index, "current");
  staff.reveal(step.index);
}

// ---- Input ------------------------------------------------------------------

/** Timestamp of the latest note-on, for the restart pause. */
let lastOnT = -Infinity;

function handleNote(ev: NoteEvent) {
  if (calibration.active) {
    if (ev.type === "on") calibration.tap(ev.t);
    if (ev.type === "on") view.press(ev.midi, "neutral");
    else view.release(ev.midi);
    return;
  }
  if (ev.type === "off") {
    view.release(ev.midi);
    return;
  }
  // After a finished run a note restarts it only after a pause (a straggler
  // or carry-on playing is ignored, and extends the wait). The restarting
  // note is the new run's first input; the old run was saved at its finish.
  const restarts = restartsOnNote("on", finishedRun(), ev.t, lastOnT);
  const ignored = finishedRun() && !restarts;
  lastOnT = ev.t;
  if (ignored) {
    view.press(ev.midi, "neutral");
    return;
  }
  if (restarts) reset();
  const grading = engine && !engine.done &&
    (mode !== "tempo" || phase === "countin" || phase === "playing");
  if (!grading) {
    view.press(ev.midi, "neutral");
    return;
  }
  if (mode === "learn") clock.note(ev.t);
  const fb = engine!.input(ev);
  view.press(ev.midi, fb.kind === "correct" ? "ok" : fb.kind === "wrong" ? "bad" : "neutral");
  if (fb.kind === "correct" && fb.stepDone) {
    const r = engine!.results[fb.step];
    // Notes-only: green only for a step played without a wrong note on the
    // way. Tempo: coloured by timing, final when its window closes.
    staff.mark(fb.step, engine instanceof TempoEngine ? markFor(r) : r.clean ? "ok" : "bad");
  }
  if (engine instanceof NotesEngine) {
    showProgress();
    if (engine.done) finishRun(engine.summary());
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
/** Flash the activity light: proof the instrument is reaching the page. */
function blink(ev: NoteEvent) {
  if (ev.type !== "on") return;
  ui.activity.classList.add("on");
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => ui.activity.classList.remove("on"), 120);
}

midi.onNote = (ev) => {
  blink(ev);
  handleNote(ev);
};

let midiState: MidiState | null = null;

const MIDI_MESSAGES: Record<MidiState, string> = {
  unsupported:
    "This browser has no Web MIDI. Use Chrome, Edge or Firefox to connect an instrument.",
  insecure: "Web MIDI needs a secure (https) connection.",
  denied: "MIDI access was blocked. Allow it in the site settings to use your instrument.",
  ready: "",
};

function showDevices(devices: MidiDevice[]) {
  const prev = ui.device.value;
  // The status line belongs to whichever instrument is selected.
  const status = (text: string) => {
    if (instrument === "piano") ui.midiStatus.textContent = text;
  };
  if (devices.length === 0) {
    ui.device.replaceChildren(new Option("No MIDI devices connected", ""));
    ui.device.disabled = true;
    status("Connect your instrument by USB or Bluetooth MIDI. It will appear here.");
    return;
  }
  const opts = devices.map((d) => new Option(d.name, d.id));
  if (devices.length > 1) opts.unshift(new Option("All devices", ALL_DEVICES));
  ui.device.replaceChildren(...opts);
  ui.device.disabled = false;
  const remembered = devices.find((d) => d.name === store.settings().device)?.id;
  const has = (v: string) => [...ui.device.options].some((o) => o.value === v);
  ui.device.value = has(prev) ? prev : remembered ?? opts[0].value;
  midi.select(ui.device.value);
  status(devices.length === 1 ? `Connected: ${devices[0].name}` : `${devices.length} devices`);
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

/**
 * Log time spent in Learn mode: a whole pass when it ends, or the part
 * played when it is restarted, changed or left. Nothing if no note was played.
 */
function logLearn(complete: boolean): number {
  if (!clock.worthLogging || !(engine instanceof NotesEngine)) return 0;
  const ms = clock.ms;
  clock = new LearnClock();
  store.addLearn({
    ts: Date.now(),
    kind: "scale",
    subject: scaleKey(options),
    title: scaleTitle(options.tonic, options.type),
    ...(instrument === "guitar" ? { instrument } : {}),
    hands: options.hands,
    durationMs: ms,
    steps: engine.cursor,
    total: steps.length,
    wrongNotes: engine.summary().wrongNotes,
    complete,
  });
  syncer.schedule();
  return ms;
}

/** Learn mode: no grades, just how long the pass took and the time put in so far. */
function finishLearn() {
  const ms = logLearn(true);
  const key = scaleKey(options);
  const total = store.learnSessions()
    .filter((l) =>
      l.kind === "scale" && l.subject === key && (l.instrument ?? "piano") === instrument
    )
    .reduce((sum, l) => sum + l.durationMs, 0);
  ui.resultsTitle.textContent = "Pass complete";
  ui.best.hidden = true;
  ui.stats.replaceChildren(
    stat("This pass", formatDuration(ms)),
    ...(store.available ? [stat("Learning this scale", formatDuration(total))] : []),
  );
  ui.resultsNote.textContent =
    "Learn mode isn't graded and stays out of your practice history. When it feels secure, switch Grading to notes only or with metronome.";
  ui.timingChart.hidden = true;
  ui.results.hidden = false;
}

/** Record a finished run (if anything was played) and show its results. */
function finishRun(s: Summary) {
  if (mode === "learn") return finishLearn();
  showResults(s);
  ui.best.hidden = true;
  if (s.correct === 0 && s.wrongNotes === 0) return; // nothing was played
  const t = tempoSettings();
  const { session, saved, previousBest } = store.add({
    ts: Date.now(),
    tonic: options.tonic,
    type: options.type,
    hands: options.hands,
    instrument,
    octaves: options.octaves,
    direction: options.direction,
    mode,
    total: s.total,
    correct: s.correct,
    accuracy: s.accuracy,
    wrongNotes: s.wrongNotes,
    durationMs: Math.round(s.durationMs),
    unevenness: s.unevenness,
    velocityStd: s.velocityStd,
    notTogether: s.notTogether,
    timing: s.timing && {
      bpm: t.bpm,
      notesPerBeat: t.notesPerBeat,
      onTime: s.timing.onTime,
      early: s.timing.early,
      late: s.timing.late,
      missed: s.timing.missed,
      meanAbsMs: s.timing.meanAbsMs,
      meanSignedMs: s.timing.meanSignedMs,
    },
  });
  syncer.schedule();
  if (saved) showBest(session, previousBest);
}

function showBest(session: Session, previous: Session | null) {
  if (!previous) {
    ui.best.textContent = "First run of this exercise recorded. See your history under Progress.";
  } else if (better(session, previous)) {
    ui.best.textContent = `New personal best — up from ${pct(previous.accuracy)}.`;
    ui.best.classList.add("new");
  } else {
    ui.best.textContent = `Your best for this exercise is ${pct(previous.accuracy)}.`;
  }
  ui.best.hidden = false;
}

function showResults(s: Summary) {
  ui.resultsTitle.textContent = "Results";
  ui.best.classList.remove("new");
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
  if (SCALES[options.type].chord) {
    rows.push(stat("Chords spread", `${s.notTogether} of ${s.total}`));
  } else if (options.hands === "both") {
    rows.push(stat("Hands apart", `${s.notTogether} of ${s.total}`));
  }
  ui.stats.replaceChildren(...rows);
  ui.resultsNote.textContent = resultsNote(s);
  // Shown before the chart is drawn: it sizes itself to its container,
  // which measures zero while hidden.
  ui.results.hidden = false;
  ui.timingChart.hidden = !t;
  if (t && engine instanceof TempoEngine) {
    renderTimingChart(ui.timingChart, steps, t, engine.interval);
  }
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

// ---- Guitar ------------------------------------------------------------------

const AUDIO_MESSAGES: Record<Exclude<AudioState, "ready">, string> = {
  unsupported:
    "This browser can't analyse audio input. Use a current Chrome, Edge or Firefox for guitar.",
  insecure: "Audio input needs a secure (https) connection.",
  denied:
    "Microphone access was blocked. Allow it in the site settings so the guitar can be heard.",
  nodevice: "No audio input found. Plug in your guitar interface (a Rocksmith cable, say).",
};

const PC_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const midiName = (m: number) => `${PC_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

function setStatus(text: string, warn = false) {
  ui.midiStatus.textContent = text;
  ui.midiStatus.classList.toggle("warn", warn);
}

audio.onNote = (ev) => {
  blink(ev);
  // Tuning plucks open strings, which aren't the exercise: don't grade them.
  if (!tunerOpen) handleNote(ev);
};

audio.onDevices = (devices) => {
  ui.audioInput.replaceChildren(...devices.map((d) => new Option(d.label, d.id)));
  ui.audioInput.disabled = devices.length === 0;
  if (audio.deviceId) ui.audioInput.value = audio.deviceId;
};

// The tuner readout: the note the guitar is sounding, how far off pitch, and
// the input level, so the cable and tuning can be checked before playing.
audio.onReading = (r) => {
  ui.level.value = r.rms > 0 ? Math.max(-70, 20 * Math.log10(r.rms)) : -70;
  const note = r.midi === null ? "–" : midiName(r.midi);
  if (ui.tunerNote.textContent !== note) ui.tunerNote.textContent = note;
  const cents = r.midi === null ? "" : `${r.cents > 0 ? "+" : ""}${r.cents}¢`;
  if (ui.tunerCents.textContent !== cents) ui.tunerCents.textContent = cents;
  if (tunerOpen) {
    pendingReading = r;
    tunerFrameId ||= requestAnimationFrame(drawTuner);
  }
};

// ---- Tuner ---------------------------------------------------------------------

const STRING_NOTES = ["E2", "A2", "D3", "G3", "B3", "E4"];
const SVG_NS = "http://www.w3.org/2000/svg";
let tunerOpen = false;
let lockedString: number | null = null;
let a4 = DEFAULT_A4;
let pendingReading: Reading | null = null;
let tunerFrameId = 0;
const smoother = new TunerSmoother();

/**
 * The gauge: −50 to +50 cents, a shaded in-tune zone (±5), and a needle.
 * Built once; drawTuner only moves the needle and switches state classes.
 */
const gauge = (() => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 420 74");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Tuning gauge, flat on the left, sharp on the right");
  const x = (c: number) => 210 + c * 3.6; // ±50¢ → 30–390, room for labels
  const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text) e.textContent = text;
    svg.append(e);
    return e;
  };
  add("rect", { class: "zone", x: x(-5), y: 8, width: x(5) - x(-5), height: 40, rx: 3 });
  for (let c = -50; c <= 50; c += 10) {
    add("line", {
      class: c === 0 ? "tick centre" : "tick",
      x1: x(c),
      x2: x(c),
      y1: c === 0 ? 6 : 18,
      y2: 48,
    });
  }
  add("text", { class: "label", x: x(-50), y: 68 }, "−50¢");
  add("text", { class: "label", x: x(0), y: 68 }, "0");
  add("text", { class: "label", x: x(50), y: 68 }, "+50¢");
  const needle = add("line", { class: "needle", x1: x(0), x2: x(0), y1: 2, y2: 52 });
  ui.tunerGauge.replaceChildren(svg);
  return { svg, needle, x };
})();

function drawTuner() {
  tunerFrameId = 0;
  const r = pendingReading;
  if (!r) return;
  const freq = smoother.push(r.freq, r.t);
  for (const b of ui.tunerStrings.querySelectorAll("button")) b.classList.remove("detected");
  if (freq === null) {
    ui.tunerBig.textContent = lockedString === null ? "–" : STRING_NOTES[lockedString];
    ui.tunerHz.textContent = "";
    ui.tunerAdvice.textContent = "Pluck a string";
    gauge.svg.classList.remove("in-tune", "close", "flat", "sharp");
    gauge.needle.classList.add("idle");
    return;
  }
  const reading = lockedString === null
    ? nearestString(freq, a4)
    : againstString(freq, lockedString, a4);
  const shown = Math.max(-50, Math.min(50, reading.cents));
  gauge.needle.setAttribute("x1", String(gauge.x(shown)));
  gauge.needle.setAttribute("x2", String(gauge.x(shown)));
  gauge.needle.classList.remove("idle");
  const state = tuneState(reading.cents);
  gauge.svg.classList.remove("in-tune", "close", "flat", "sharp");
  gauge.svg.classList.add(state);
  ui.tunerBig.textContent = STRING_NOTES[reading.string];
  const c = Math.round(reading.cents);
  ui.tunerHz.textContent = `${c > 0 ? "+" : ""}${c}¢ · ${freq.toFixed(1)} Hz`;
  const advice = Math.abs(reading.cents) > 50
    ? (reading.cents < 0 ? "Well flat: keep tuning up" : "Well sharp: keep tuning down")
    : tuneAdvice(reading.cents);
  if (ui.tunerAdvice.textContent !== advice) ui.tunerAdvice.textContent = advice;
  ui.tunerStrings.querySelector(`[data-string="${reading.string}"]`)?.classList.add("detected");
}

function setTuner(open: boolean) {
  tunerOpen = open;
  ui.tunerPanel.hidden = !open;
  ui.tunerOpen.setAttribute("aria-expanded", String(open));
  smoother.reset();
  pendingReading = null;
  if (open) {
    reset(); // a run in progress would be graded on tuning plucks
    ui.tunerAdvice.textContent = "Pluck a string";
    ui.tunerPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function setReference(value: number) {
  a4 = Math.round(Math.min(MAX_A4, Math.max(MIN_A4, value)));
  ui.a4.value = String(a4);
  audio.setReference(a4);
  smoother.reset();
}

async function startGuitar(deviceId?: string) {
  setStatus("Connecting to your audio input…");
  let state = await audio.start(deviceId);
  // Prefer the input used last time, found by name (ids change).
  const saved = store.settings().audioDevice;
  if (state === "ready" && !deviceId && saved) {
    const d = (await audio.devices()).find((x) => x.label === saved);
    if (d && d.id !== audio.deviceId) state = await audio.start(d.id);
  }
  if (instrument !== "guitar") return; // switched away while connecting
  if (state !== "ready") {
    setStatus(AUDIO_MESSAGES[state], true);
    return;
  }
  setStatus(
    `Listening: ${ui.audioInput.selectedOptions[0]?.textContent ?? "audio input"}. ` +
      "Tune up first: an out-of-tune string can read as the wrong note.",
  );
}

let midiStarted = false;

/**
 * Ask for MIDI the first time piano is chosen, not on page load: someone
 * practising guitar is never prompted for a device they don't use.
 */
function startMidi() {
  if (midiStarted) return;
  midiStarted = true;
  midi.onDevices = showDevices;
  // Chrome asks permission for Web MIDI and the promise waits on the
  // prompt, so say what it is waiting for rather than "looking" forever.
  const promptHint = setTimeout(() => {
    if (instrument === "piano") {
      setStatus("Allow MIDI access in your browser's prompt to use your instrument.");
    }
  }, 1500);
  midi.init().then((state) => {
    clearTimeout(promptHint);
    midiState = state;
    if (state === "ready") return;
    ui.device.replaceChildren(new Option("MIDI unavailable", ""));
    ui.device.disabled = true;
    if (instrument === "piano") setStatus(MIDI_MESSAGES[state], true);
  });
}

function showMidiStatus() {
  if (midiState === "ready") showDevices(midi.devices());
  else if (midiState) setStatus(MIDI_MESSAGES[midiState], true);
  // Still waiting on MIDI (its permission prompt, say): don't leave the
  // guitar's last message showing.
  else setStatus("Looking for MIDI instruments…");
}

/** Switch between piano (MIDI, keyboard) and guitar (audio, fretboard). */
function setInstrument(next: Instrument) {
  instrument = next;
  ui.instrument.value = next;
  for (const x of document.querySelectorAll<HTMLElement>(".guitar-only")) {
    x.hidden = next !== "guitar";
  }
  for (const x of document.querySelectorAll<HTMLElement>(".piano-only")) {
    x.hidden = next !== "piano";
  }
  view = next === "guitar" ? fretboard : keyboard;
  if (next === "guitar" && SCALES[pick.type].chord) {
    pick = { ...pick, type: pick.ring === "major" ? "major-arpeggio" : "minor-arpeggio" };
  }
  renderPicker();
  // A position spans about two octaves; more would mean shifting.
  for (const o of ui.octaves.options) o.disabled = next === "guitar" && Number(o.value) > 2;
  if (next === "guitar" && Number(ui.octaves.value) > 2) ui.octaves.value = "2";
  if (next === "guitar") {
    void startGuitar();
  } else {
    audio.stop();
    setTuner(false);
    startMidi();
    showMidiStatus();
  }
  rebuild();
}

ui.position.replaceChildren(...POSITIONS.map((p) => new Option(positionLabel(p), String(p))));

/**
 * Measure the latency offset: a count-in and eight clicks, tapped along
 * on the instrument (or computer keyboard). Note-ons go to the
 * calibration meanwhile, not to the exercise.
 */
async function calibrate() {
  if (calibration.active) return;
  reset();
  ui.calibrate.disabled = true;
  ui.calibrateStatus.textContent =
    "After the count-in, tap any key on your instrument along with every click…";
  const r = await calibration.run();
  ui.calibrate.disabled = false;
  ui.calibrateStatus.textContent = describeLatency(r);
  if (r.ok) {
    ui.latency.value = String(r.setting);
    persistSettings();
  }
}

// ---- Wiring -----------------------------------------------------------------

function toggleTempo() {
  if (phase === "countin" || phase === "playing") reset();
  else void startTempo();
}

ui.form.addEventListener("submit", (e) => e.preventDefault());
ui.variants.addEventListener("change", (e) => {
  const type = (e.target as HTMLInputElement).value as ScaleType;
  pick = { ...pick, type, tonic: resolveTonic(pick.tonic, type) };
  renderPicker();
  rebuild();
});
for (const s of [ui.hands, ui.octaves, ui.direction, ui.mode, ui.subdivision, ui.position]) {
  s.addEventListener("change", rebuild);
}
// BPM and latency are read at Start, so editing them needs no rebuild —
// but it does end a run in progress, whose timing no longer matches.
for (const s of [ui.bpm, ui.latency]) s.addEventListener("change", reset);
ui.fingering.addEventListener("change", applyFingering);
// Leaving part way through still counts the time spent learning.
addEventListener("pagehide", () => logLearn(false));
ui.form.addEventListener("change", persistSettings);
// Remembered by name: a port's id changes when the instrument reconnects.
ui.device.addEventListener("change", () => {
  midi.select(ui.device.value);
  const name = ui.device.selectedOptions[0]?.textContent;
  if (name && ui.device.value !== ALL_DEVICES) store.saveSettings({ device: name });
});
ui.tunerOpen.addEventListener("click", () => setTuner(!tunerOpen));
ui.tunerClose.addEventListener("click", () => setTuner(false));
ui.tunerStrings.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-string]");
  if (!b) return;
  lockedString = b.dataset.string === "auto" ? null : Number(b.dataset.string);
  for (const x of ui.tunerStrings.querySelectorAll("button")) {
    x.setAttribute("aria-pressed", String(x === b));
  }
  smoother.reset();
});
ui.a4.addEventListener("change", () => {
  setReference(Number(ui.a4.value) || DEFAULT_A4);
  persistSettings();
  rebuild();
});
ui.instrument.addEventListener("change", () => {
  setInstrument(ui.instrument.value as Instrument);
  persistSettings(); // outside the form, so no form change event
});
ui.audioInput.addEventListener("change", () => {
  const label = ui.audioInput.selectedOptions[0]?.textContent;
  if (label) store.saveSettings({ audioDevice: label });
  void startGuitar(ui.audioInput.value);
});
// Browsers only let audio run after a user gesture.
for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, () => void audio.resume());
}
ui.start.addEventListener("click", () => {
  toggleTempo();
  ui.start.blur();
});
ui.restart.addEventListener("click", () => {
  reset();
  ui.restart.blur();
});
ui.copyLink.addEventListener("click", () => void copyLink());
ui.calibrate.addEventListener("click", () => void calibrate());
/** Set a form select and let its change handlers run, as if picked by hand. */
function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const commands: Command[] = [
  {
    id: "play",
    label: "Play / pause",
    group: "Playback",
    shortcut: "Space",
    keywords: ["start", "stop", "metronome"],
    // Notes-only mode has nothing to play; Space starts over, as before.
    run: () => (mode === "tempo" ? toggleTempo() : reset()),
  },
  { id: "restart", label: "Restart", group: "Playback", shortcut: "R", run: () => reset() },
  { id: "stop", label: "Stop", group: "Playback", shortcut: "Escape", run: () => reset() },
  {
    id: "mode.notes",
    label: "Grading: notes only",
    group: "Practice",
    keywords: ["wait"],
    run: () => choose(ui.mode, "notes"),
  },
  {
    id: "mode.tempo",
    label: "Grading: with metronome",
    group: "Practice",
    keywords: ["tempo", "time"],
    run: () => choose(ui.mode, "tempo"),
  },
  {
    id: "mode.learn",
    label: "Grading: learn (not graded)",
    group: "Practice",
    keywords: ["learn", "new", "hints", "ungraded"],
    run: () => choose(ui.mode, "learn"),
  },
  {
    id: "instrument.piano",
    label: "Instrument: piano",
    group: "Practice",
    keywords: ["midi", "keyboard"],
    run: () => choose(ui.instrument, "piano"),
  },
  {
    id: "instrument.guitar",
    label: "Instrument: guitar",
    group: "Practice",
    keywords: ["audio"],
    run: () => choose(ui.instrument, "guitar"),
  },
  {
    id: "fingering",
    label: "Show / hide fingers",
    group: "View",
    shortcut: "Alt+KeyN",
    keywords: ["fingering"],
    run: () => ui.fingering.click(),
  },
  {
    id: "sheet",
    label: "Music sheet light / dark",
    group: "View",
    shortcut: "Alt+KeyB",
    keywords: ["theme"],
    run: () => el("sheet-theme").click(),
  },
  {
    id: "copy-link",
    label: "Copy link to this exercise",
    group: "Practice",
    shortcut: "Alt+KeyC",
    keywords: ["share", "url"],
    run: () => void copyLink(),
  },
  {
    id: "calibrate",
    label: "Measure latency",
    group: "Practice",
    keywords: ["calibrate", "offset", "delay"],
    run: () => void calibrate(),
  },
  {
    id: "tuner",
    label: "Open the tuner",
    group: "Practice",
    keywords: ["guitar", "tune"],
    enabled: () => instrument === "guitar",
    run: () => setTuner(true),
  },
];
installCommands([...siteCommands(), ...commands]);
ui.storageWarning.hidden = store.available;
sheetThemeToggle(el<HTMLButtonElement>("sheet-theme"), [ui.staff], store);

restoreSettings();
renderPicker();
setInstrument(ui.instrument.value as Instrument); // also builds the exercise
syncUrl();

// Test hook: lets browser automation play notes through exactly the path a
// MIDI message takes, since DevTools cannot provide a real MIDI device.
(globalThis as unknown as { __practice: unknown }).__practice = {
  note: (midiNote: number, on = true, t = performance.now()) =>
    midi.onNote({ type: on ? "on" : "off", midi: midiNote, velocity: 80, t }),
  targets: currentTargets,
  calibration,
  engine: () => engine,
  // Guitar: synthesise plucked notes and play them through the real
  // worklet → detector → note tracker, in place of the audio input.
  // Rendered first, then started at `startAt` (performance.now ms) if given:
  // rendering takes a noticeable moment, which must not count as lateness.
  // Tuner: a plucked tone at any frequency (e.g. a detuned string).
  toneTest: (freq: number, seconds = 2) => audio.play(pluck(freq, 48000, { seconds }), 48000),
  audioTest: async (midis: number[], spacing = 0.45, startAt?: number) => {
    const samples = pluckSequence(midis, 48000, spacing, { seconds: spacing + 0.2 });
    if (startAt !== undefined) {
      await new Promise((r) => setTimeout(r, Math.max(0, startAt - performance.now())));
    }
    return audio.play(samples, 48000);
  },
};
