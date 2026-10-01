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
import { AudioInput, type AudioState } from "./lib/audio_input.ts";
import { FretboardView } from "./lib/fretboard_view.ts";
import { boxFor, layout, positionLabel, POSITIONS, tonicMidiFor } from "./lib/guitar.ts";
import { KeyboardView } from "./lib/keyboard_view.ts";
import { pluckSequence } from "./lib/pluck.ts";
import { Metronome } from "./lib/metronome.ts";
import { ALL_DEVICES, Midi, type MidiDevice, type MidiState } from "./lib/midi.ts";
import { better, type Instrument, ProgressStore, type Session } from "./lib/progress_store.ts";
import { listenQwerty, resolveOctave, Synth } from "./lib/qwerty.ts";
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
const store = ProgressStore.fromWindow();

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

/** Put the last-used choices back into the form (each is validated on read). */
function restoreSettings() {
  const saved = store.settings();
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
  });
}

function rebuild() {
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
    const names = new Map(steps.flatMap((s) => s.notes.map((n) => [n.midi, nameOf(n.spelled)])));
    fretboard.setLayout(box, layout(all, box), names);
  } else {
    keyboard.setRange(Math.min(...all), Math.max(...all));
    keyboard.setScale(all);
  }
  // In tempo mode the staff shows the rhythm being asked for.
  const duration = mode === "tempo" ? DURATIONS[tempoSettings().notesPerBeat] : "q";
  staff.render(
    steps,
    keySignatureFifths(options.tonic, options.type),
    duration,
    instrument === "guitar",
  );
  reset();
}

function reset() {
  metronome.stop();
  cancelAnimationFrame(frame);
  engine = mode === "notes" ? new NotesEngine(steps) : null;
  phase = "idle";
  shownCurrent = -1;
  view.releaseAll();
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
  view.setTargets([]);
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
  view.setTargets(steps[i].notes.map((n) => n.midi));
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

function currentTargets(): number[] {
  return currentStep()?.notes.map((n) => n.midi) ?? [];
}

/** Status line and highlights between notes (notes-only), or before Start. */
function showProgress() {
  if (engine instanceof TempoEngine) return; // the animation frame owns the view
  const step = currentStep();
  view.setTargets(currentTargets());
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
  view.reveal(step.notes[0].midi);
  staff.mark(step.index, "current");
  staff.reveal(step.index);
}

// ---- Input ------------------------------------------------------------------

function handleNote(ev: NoteEvent) {
  if (ev.type === "off") {
    view.release(ev.midi);
    return;
  }
  const grading = engine && !engine.done &&
    (mode === "notes" || phase === "countin" || phase === "playing");
  if (!grading) {
    view.press(ev.midi, "neutral");
    return;
  }
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

/** Record a finished run (if anything was played) and show its results. */
function finishRun(s: Summary) {
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
  if (steps[0].notes.length > 1) rows.push(stat("Hands apart", `${s.notTogether} of ${s.total}`));
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
  handleNote(ev);
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
};

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
  setStatus(`Listening: ${ui.audioInput.selectedOptions[0]?.textContent ?? "audio input"}`);
}

function showMidiStatus() {
  if (midiState === "ready") showDevices(midi.devices());
  else if (midiState) setStatus(MIDI_MESSAGES[midiState], true);
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
  // A position spans about two octaves; more would mean shifting.
  for (const o of ui.octaves.options) o.disabled = next === "guitar" && Number(o.value) > 2;
  if (next === "guitar" && Number(ui.octaves.value) > 2) ui.octaves.value = "2";
  if (next === "guitar") {
    void startGuitar();
  } else {
    audio.stop();
    showMidiStatus();
  }
  rebuild();
}

ui.position.replaceChildren(...POSITIONS.map((p) => new Option(positionLabel(p), String(p))));

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
ui.form.addEventListener("change", persistSettings);
// Remembered by name: a port's id changes when the instrument reconnects.
ui.device.addEventListener("change", () => {
  midi.select(ui.device.value);
  const name = ui.device.selectedOptions[0]?.textContent;
  if (name && ui.device.value !== ALL_DEVICES) store.saveSettings({ device: name });
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
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (e.code !== "Space" || ["BUTTON", "SELECT", "INPUT", "A"].includes(t.tagName)) return;
  e.preventDefault();
  if (mode === "tempo") toggleTempo();
  else reset();
});

ui.storageWarning.hidden = store.available;

restoreSettings();
renderPicker();
setInstrument(ui.instrument.value as Instrument); // also builds the exercise

midi.onDevices = showDevices;
// Chrome asks permission for Web MIDI and the promise waits on the prompt,
// so say what it is waiting for rather than "looking" indefinitely.
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

// Test hook: lets browser automation play notes through exactly the path a
// MIDI message takes, since DevTools cannot provide a real MIDI device.
(globalThis as unknown as { __practice: unknown }).__practice = {
  note: (midiNote: number, on = true, t = performance.now()) =>
    midi.onNote({ type: on ? "on" : "off", midi: midiNote, velocity: 80, t }),
  targets: currentTargets,
  engine: () => engine,
  // Guitar: synthesise plucked notes and play them through the real
  // worklet → detector → note tracker, in place of the audio input.
  // Rendered first, then started at `startAt` (performance.now ms) if given:
  // rendering takes a noticeable moment, which must not count as lateness.
  audioTest: async (midis: number[], spacing = 0.45, startAt?: number) => {
    const samples = pluckSequence(midis, 48000, spacing, { seconds: spacing + 0.2 });
    if (startAt !== undefined) {
      await new Promise((r) => setTimeout(r, Math.max(0, startAt - performance.now())));
    }
    return audio.play(samples, 48000);
  },
};
