// The songs page: a library of uploaded MusicXML scores, the rendered
// score, and practice in three modes. Wait mode holds on each step until
// it is played; tempo mode runs at a fixed tempo with a count-in, grading
// timing and counting misses; listen mode plays the selection back.
// Any of them can cover one hand and a range of measures, and repeat.
//
// The score comes from score_view.ts (OpenSheetMusicDisplay); score.ts
// turns it into the same Steps the scales grade, so NotesEngine and
// TempoEngine are shared with the scales page.

import {
  type NoteEvent,
  NotesEngine,
  type StepResult,
  summarize,
  type Summary,
  TempoEngine,
} from "./lib/engine.ts";
import type { Command } from "./lib/commands.ts";
import { setPlaying } from "./lib/transport.ts";
import { Calibration, describeLatency } from "./lib/calibration.ts";
import { KeyboardView } from "./lib/keyboard_view.ts";
import { Metronome } from "./lib/metronome.ts";
import { ALL_DEVICES, Midi, type MidiDevice, type MidiState } from "./lib/midi.ts";
import { ProgressStore } from "./lib/progress_store.ts";
import { listenQwerty, resolveOctave, Synth } from "./lib/qwerty.ts";
import {
  bpmAt,
  buildScore,
  type MeasureStat,
  measureStats,
  type Practice,
  practiceSteps,
  type Score,
  type Selection,
  sliceFrom,
  stepFromMeasure,
  stepOffsets,
  stepOfRef,
  weakestRange,
} from "./lib/score.ts";
import { ScoreView } from "./lib/score_view.ts";
import {
  type SongFormat,
  songFormat,
  SongLibrary,
  type SongMeta,
  titleFromFileName,
  uploadProblem,
} from "./lib/song_library.ts";
import { playPlan, SongPlayer } from "./lib/song_player.ts";
import { betterSong, type SongSession } from "./lib/song_session.ts";
import type { StepMark } from "./lib/staff_view.ts";

import { installCommands } from "./lib/palette.ts";
import { registerServiceWorker } from "./lib/pwa.ts";
import { siteCommands } from "./lib/site_commands.ts";
import { sheetThemeToggle } from "./lib/sheet_theme.ts";

registerServiceWorker();
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  storageWarning: el("storage-warning"),
  device: el<HTMLSelectElement>("midi-input"),
  midiStatus: el("midi-status"),
  activity: el("midi-activity"),
  upload: el<HTMLInputElement>("upload"),
  dropZone: el("drop-zone"),
  libraryStatus: el("library-status"),
  songList: el<HTMLUListElement>("song-list"),
  song: el("song"),
  title: el<HTMLInputElement>("song-title"),
  composer: el("song-composer"),
  status: el("exercise-status"),
  start: el<HTMLButtonElement>("start"),
  restart: el<HTMLButtonElement>("restart"),
  stop: el<HTMLButtonElement>("stop"),
  toStart: el<HTMLButtonElement>("to-start"),
  prevMeasure: el<HTMLButtonElement>("prev-measure"),
  nextMeasure: el<HTMLButtonElement>("next-measure"),
  position: el("transport-position"),
  viewToggle: el<HTMLButtonElement>("view-toggle"),
  zoomIn: el<HTMLButtonElement>("zoom-in"),
  zoomOut: el<HTMLButtonElement>("zoom-out"),
  big: el<HTMLButtonElement>("big-screen"),
  form: el<HTMLFormElement>("song-form"),
  mode: el<HTMLSelectElement>("song-mode"),
  hands: el<HTMLSelectElement>("song-hands"),
  from: el<HTMLInputElement>("song-from"),
  to: el<HTMLInputElement>("song-to"),
  whole: el<HTMLButtonElement>("song-whole"),
  tempo: el<HTMLInputElement>("song-tempo"),
  loop: el<HTMLInputElement>("song-loop"),
  metronome: el<HTMLInputElement>("song-metronome"),
  accompany: el<HTMLInputElement>("song-accompany"),
  fingering: el<HTMLInputElement>("fingering"),
  latency: el<HTMLInputElement>("latency"),
  calibrate: el<HTMLButtonElement>("calibrate"),
  calibrateStatus: el("calibrate-status"),
  score: el("score"),
  keyboard: el("keyboard"),
  results: el("results"),
  best: el("results-best"),
  stats: el("results-stats"),
  heat: el("heat"),
  loopWeakest: el<HTMLButtonElement>("loop-weakest"),
  resultsNote: el("results-note"),
};

type Mode = "notes" | "tempo" | "listen";
type Phase = "idle" | "countin" | "playing" | "paused" | "done";

const store = ProgressStore.fromWindow();
const view = new ScoreView(ui.score);
const keyboard = new KeyboardView(ui.keyboard);
const player = new SongPlayer();
const synth = new Synth();
const midi = new Midi();
const calibration = new Calibration(new Metronome());

let library: SongLibrary | null = null;
let song: { meta: SongMeta | null; score: Score } | null = null;
let practice: Practice | null = null;
/** For each step, the refs of the notes it marks on the score. */
let stepRefs: number[][] = [];
let mode: Mode = "notes";
let engine: NotesEngine | TempoEngine | null = null;
/**
 * A run is played in segments: each start, resume or seek begins a new
 * engine on the selection from step `offset` on (sliceFrom). `attempted`
 * keeps, per step of the selection, the latest result of each step played,
 * so the run is scored over what was actually played (summarize).
 */
let offset = 0;
let segment: Practice | null = null;
let attempted = new Map<number, StepResult>();
/** Where play starts or resumes (a step of the selection), when not playing. */
let position = 0;
/** When each step of the playing segment sounds, in ms after startTime. */
let segOffsets: number[] = [];
let phase: Phase = "idle";
let startTime = 0;
let countIn: number[] = [];
let endTime = 0;
let frame = 0;
let shownCurrent = -1;
let loopTimer = 0;

// ---- Library ------------------------------------------------------------------

function setLibraryStatus(text: string, warn = false) {
  ui.libraryStatus.textContent = text;
  ui.libraryStatus.classList.toggle("warn", warn);
}

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

async function renderLibrary() {
  const songs = library ? await library.list() : [];
  const bests = new Map<string, number>();
  for (const s of store.songSessions()) {
    bests.set(s.songId, Math.max(bests.get(s.songId) ?? 0, s.accuracy));
  }
  ui.songList.replaceChildren(...songs.map((s) => {
    const li = document.createElement("li");
    li.classList.toggle("current", song?.meta?.id === s.id);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "song-open";
    const title = document.createElement("span");
    title.className = "song-name";
    title.textContent = s.title;
    const meta = document.createElement("span");
    meta.className = "song-meta";
    const best = bests.get(s.id);
    meta.textContent = [
      s.composer,
      s.lastPractised ? `practised ${day.format(s.lastPractised)}` : "not practised yet",
      best !== undefined ? `best ${Math.round(best * 100)}%` : "",
    ].filter(Boolean).join(" · ");
    open.append(title, meta);
    open.addEventListener("click", () => void openSong(s.id));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary small";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete ${s.title}`);
    // Two steps, no dialog: the first press asks, the second deletes.
    del.addEventListener("click", async () => {
      if (del.dataset.confirm !== "1") {
        del.dataset.confirm = "1";
        del.textContent = "Delete for good?";
        setTimeout(() => {
          del.dataset.confirm = "";
          del.textContent = "Delete";
        }, 4000);
        return;
      }
      await library?.remove(s.id);
      store.removeSong(s.id);
      if (song?.meta?.id === s.id) closeSong();
      setLibraryStatus(`Deleted ${s.title}, and its history.`);
      void renderLibrary();
    });
    li.append(open, del);
    return li;
  }));
  if (!songs.length && library) {
    setLibraryStatus("No songs of your own yet. Open a starter piece, or add a MusicXML score.");
  }
}

async function addFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes);
  if (problem) {
    setLibraryStatus(problem, true);
    return;
  }
  const format = songFormat(bytes)!;
  setLibraryStatus(`Reading ${file.name}…`);
  try {
    const info = await show(bytes.buffer as ArrayBuffer, format, null);
    const title = info.title || titleFromFileName(file.name);
    if (!library) {
      setLibraryStatus(`Opened ${title}. This browser won't keep it after you leave.`, true);
      ui.title.value = title;
      return;
    }
    const rec = await library.add(
      { title, composer: info.composer, fileName: file.name, format },
      bytes.buffer as ArrayBuffer,
    );
    song!.meta = rec;
    ui.title.value = title;
    store.saveSettings({ lastSong: rec.id });
    setLibraryStatus(`Added ${title}.`);
    void renderLibrary();
  } catch (e) {
    setLibraryStatus(e instanceof Error ? e.message : "That file couldn't be opened.", true);
  }
}

async function openSong(id: string) {
  const rec = await library?.get(id);
  if (!rec) return;
  try {
    await show(rec.data, rec.format, rec);
    store.saveSettings({ lastSong: id });
    setLibraryStatus("");
    void renderLibrary();
    ui.song.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setLibraryStatus(e instanceof Error ? e.message : "That song couldn't be opened.", true);
  }
}

/** Render a score and set the page up to practise it. */
async function show(data: ArrayBuffer, format: SongFormat, meta: SongMeta | null) {
  stop();
  ui.song.hidden = false; // OSMD lays out to the container's width
  const info = await view.load(data, format);
  const score = buildScore(view.walk());
  if (!score.events.length) {
    ui.song.hidden = true;
    throw new Error("This score has no notes to play.");
  }
  song = { meta, score };
  ui.title.value = meta?.title ?? info.title;
  ui.composer.textContent = meta?.composer ?? info.composer;
  ui.from.max = ui.to.max = String(score.measureCount);
  ui.from.value = "1";
  ui.to.value = String(score.measureCount);
  ui.hands.disabled = !score.twoHands;
  if (!score.twoHands) ui.hands.value = "both";
  view.setFingering(ui.fingering.checked);
  rebuild();
  return info;
}

function closeSong() {
  stop();
  song = null;
  practice = null;
  ui.song.hidden = true;
  ui.results.hidden = true;
}

// ---- Selection and lifecycle ----------------------------------------------------

function selection(): Selection {
  const max = song?.score.measureCount ?? 1;
  const clamp = (v: number, d: number) =>
    Math.min(max, Math.max(1, Number.isFinite(v) ? Math.round(v) : d));
  let from = clamp(Number(ui.from.value), 1);
  let to = clamp(Number(ui.to.value), max);
  if (to < from) [from, to] = [to, from];
  ui.from.value = String(from);
  ui.to.value = String(to);
  return { hands: ui.hands.value as Selection["hands"], from, to };
}

const tempoPct = () => Math.min(200, Math.max(10, Number(ui.tempo.value) || 100));

/** Show only the options that apply to the mode and hands chosen. */
function showOptions() {
  for (const x of ui.form.querySelectorAll<HTMLElement>("[data-modes]")) {
    x.hidden = !x.dataset.modes!.split(" ").includes(mode);
  }
  const accompany = ui.accompany.closest("label")!;
  accompany.hidden = mode === "listen" || ui.hands.value === "both";
}

function rebuild() {
  if (!song) return;
  mode = ui.mode.value as Mode;
  showOptions();
  const sel = selection();
  practice = practiceSteps(song.score, sel);
  const plays = (hand: string) => sel.hands === "both" || hand === sel.hands;
  stepRefs = practice.events.map((e) =>
    e.notes.filter((n) => plays(n.hand) && n.tie !== "continue").map((n) => n.ref)
  );
  const all = practice.all.map((n) => n.midi);
  if (all.length) keyboard.setRange(Math.min(...all), Math.max(...all));
  reset();
}

function stop() {
  player.stop();
  cancelAnimationFrame(frame);
  clearTimeout(loopTimer);
}

/** Keep the finished part of the current segment: its steps before `upto`. */
function keepSegment(upto = Infinity) {
  if (!engine) return;
  engine.results.forEach((r, j) => {
    if (j < upto && r.status !== "pending") attempted.set(offset + j, r);
  });
}

/** Back to the start of the selection, nothing played. */
function reset() {
  stop();
  attempted = new Map();
  position = 0;
  phase = "idle";
  shownCurrent = -1;
  keyboard.releaseAll();
  view.clearMarks();
  ui.results.hidden = true;
  beginWaiting(0);
  showProgress();
}

/** Wait mode: grade from step k on. (The other modes play from there on Play.) */
function beginWaiting(k: number) {
  engine = null;
  segment = null;
  offset = k;
  if (mode !== "notes" || !practice?.steps.length) return;
  segment = sliceFrom(practice, k);
  engine = new NotesEngine(segment.steps);
}

const playingNow = () => phase === "countin" || phase === "playing";

/** The play button, stop and the position readout, for the current state. */
function showTransport() {
  setPlaying(ui.start, playingNow(), mode === "listen" ? ["Listen", "Pause"] : ["Play", "Pause"]);
  ui.start.hidden = mode === "notes";
  ui.stop.disabled = !playingNow() && phase !== "paused";
  const n = practice?.steps.length ?? 0;
  const i = currentStep();
  ui.position.textContent = n && i >= 0 ? `m. ${measureOf(i)} · ${i + 1}/${n}` : "";
}

/** The step the player is at, in the selection (-1 when finished). */
function currentStep(): number {
  if (!practice?.steps.length) return -1;
  if (engine instanceof NotesEngine) return engine.done ? -1 : offset + engine.cursor;
  if (phase === "done") return -1;
  if (playingNow()) return Math.max(0, shownCurrent);
  return position;
}

function fingersFor(i: number): (number | null)[] | undefined {
  if (!ui.fingering.checked || !practice) return undefined;
  const e = practice.events[i];
  return practice.steps[i].notes.map((n) => {
    const f = e.notes.find((x) => x.midi === n.midi && x.hand === n.hand)?.finger;
    const num = f === undefined ? NaN : parseInt(f, 10);
    return Number.isFinite(num) ? num : null;
  });
}

function showTargets(i: number) {
  if (!practice || i < 0) {
    keyboard.setTargets([]);
    return;
  }
  keyboard.setTargets(practice.steps[i].notes.map((n) => n.midi), fingersFor(i));
}

function measureOf(i: number): number {
  return practice?.events[i]?.measure ?? 0;
}

/** Status line and highlights (wait mode, and before Play or while paused). */
function showProgress() {
  if (!song || !practice) return;
  showTransport();
  if (!practice.steps.length) {
    ui.status.textContent = "Nothing to play for this hand in these measures.";
    keyboard.setTargets([]);
    return;
  }
  if (playingNow()) return; // the frame owns the view
  const i = currentStep();
  showTargets(i);
  if (i < 0) {
    view.hideCursor();
    ui.status.textContent = "Done. Press Restart (R) to go again.";
    return;
  }
  // Move the "current" mark, leaving steps already graded as they are.
  if (shownCurrent >= 0 && shownCurrent !== i && !attempted.has(shownCurrent)) {
    view.mark(stepRefs[shownCurrent], null);
  }
  shownCurrent = i;
  view.mark(stepRefs[i], "current");
  view.showCursor(stepRefs[i]);
  view.reveal(stepRefs[i][0]);
  const n = practice.steps.length;
  const where = `measure ${measureOf(i)}`;
  ui.status.textContent = mode === "notes"
    ? (i === 0 && !attempted.size
      ? `Play the first note to begin · ${where}`
      : `Note ${i + 1} of ${n} · ${where}`)
    : phase === "paused"
    ? `Paused at ${where}. Space to resume.`
    : i > 0
    ? `Ready at ${where}. Space to play from here.`
    : mode === "tempo"
    ? "Press Play (or Space) for a one-bar count-in."
    : "Press Play (or Space) to listen.";
}

// ---- Tempo and listen ----------------------------------------------------------

/** Play (tempo or listen) from step k of the selection. */
async function start(k = position) {
  if (!song || !practice?.steps.length || mode === "notes") return;
  stop();
  if (phase === "done") {
    // A finished run starts over.
    attempted = new Map();
    view.clearMarks();
    k = 0;
  }
  ui.results.hidden = true;
  offset = Math.min(Math.max(0, k), practice.steps.length - 1);
  position = offset;
  segment = sliceFrom(practice, offset);
  const pct = tempoPct();
  const sel = selection();
  const notes = mode === "listen"
    ? "all"
    : ui.accompany.checked && sel.hands !== "both"
    ? "other"
    : "none";
  const plan = playPlan(song.score, segment, {
    pct,
    metronome: mode !== "listen" && ui.metronome.checked,
    notes,
    countIn: mode === "tempo",
  });
  engine = null;
  segOffsets = stepOffsets(song.score, segment, pct);
  phase = mode === "tempo" ? "countin" : "playing";
  if (shownCurrent >= 0 && !attempted.has(shownCurrent)) view.mark(stepRefs[shownCurrent], null);
  shownCurrent = -1;
  showTransport();
  const sched = await player.start(plan);
  startTime = sched.startTime;
  countIn = sched.countIn;
  endTime = startTime + plan.end;
  if (mode === "tempo") {
    engine = new TempoEngine(segment.steps, {
      bpm: (bpmAt(song.score.tempo, segment.startBeat) * pct) / 100,
      notesPerBeat: 1,
      startTime,
      latencyMs: Number(ui.latency.value) || 0,
      offsets: stepOffsets(song.score, segment, pct),
    });
  }
  frame = requestAnimationFrame(tick);
}

/** Stop playing, keeping the place: Space resumes from the step it reached. */
function pause() {
  if (!playingNow()) return;
  stop();
  const at = Math.max(offset, shownCurrent);
  keepSegment(at - offset);
  if (shownCurrent >= 0 && !attempted.has(shownCurrent)) view.mark(stepRefs[shownCurrent], null);
  position = at;
  phase = "paused";
  engine = null;
  showProgress();
}

function togglePlay() {
  if (mode === "notes") return;
  if (playingNow()) pause();
  else void start();
}

/**
 * Move to step k: while playing, carry on playing from there; in wait mode
 * the cursor jumps there; otherwise it's where Play starts.
 */
function seek(k: number) {
  if (!practice?.steps.length) return;
  k = Math.min(Math.max(0, k), practice.steps.length - 1);
  if (playingNow()) {
    pause();
    void start(k);
    return;
  }
  if (phase === "done") {
    attempted = new Map();
    view.clearMarks();
    phase = "idle";
  }
  if (mode === "notes") {
    if (engine instanceof NotesEngine) keepSegment(engine.cursor);
    beginWaiting(k);
  }
  position = k;
  showProgress();
}

function skipMeasure(dir: -1 | 1) {
  if (!practice?.steps.length) return;
  const from = currentStep() < 0 ? practice.steps.length - 1 : currentStep();
  seek(stepFromMeasure(practice, from, dir));
}

/** Back to the start; if it was playing, play again from the start. */
function restart() {
  const wasPlaying = playingNow();
  reset();
  if (wasPlaying) void start(0);
}

function markFor(r: StepResult): StepMark {
  if (r.status !== "ok" || !r.clean) return "bad";
  if (r.grade === "early") return "early";
  if (r.grade === "late") return "late";
  return "ok";
}

/** Highlight step i of the selection as the one being played. */
function setCurrent(i: number) {
  if (i === shownCurrent || !practice) return;
  const prev = engine?.results[shownCurrent - offset];
  if (shownCurrent >= 0 && (!prev || prev.status === "pending")) {
    view.mark(stepRefs[shownCurrent], null);
  }
  shownCurrent = i;
  const r = engine?.results[i - offset];
  if (!r || r.status === "pending") view.mark(stepRefs[i], "current");
  // While playing, glideCursor() moves the cursor every frame.
  if (!playingNow()) view.showCursor(stepRefs[i]);
  showTargets(i);
  view.reveal(stepRefs[i][0]);
  showTransport();
}

/** Move the cursor smoothly, by the clock: between this step and the next. */
function glideCursor(now: number) {
  if (!segOffsets.length) return;
  const t = now - startTime;
  let j = 0;
  while (j + 1 < segOffsets.length && segOffsets[j + 1] <= t) j++;
  const next = segOffsets[j + 1] ?? endTime - startTime;
  const span = next - segOffsets[j];
  const frac = t <= segOffsets[j] || span <= 0 ? 0 : (t - segOffsets[j]) / span;
  const to = stepRefs[offset + j + 1] ?? stepRefs[offset + j];
  view.glide(stepRefs[offset + j], to, frac);
}

function tick() {
  const now = performance.now();
  const seg = segment!;
  if (mode === "listen") {
    if (now >= endTime) {
      finishListen();
      return;
    }
    let j = 0;
    while (j + 1 < segOffsets.length && startTime + segOffsets[j + 1] <= now) j++;
    if (now >= startTime) setCurrent(offset + j);
    glideCursor(now);
    ui.status.textContent = now < startTime
      ? "Listening…"
      : `Listening · measure ${measureOf(offset + j)}`;
    frame = requestAnimationFrame(tick);
    return;
  }
  const e = engine as TempoEngine;
  if (phase === "countin") {
    const left = countIn.filter((t) => t > now).length;
    if (now >= e.dueAt(0) - e.toleranceAt(0) * 2) phase = "playing";
    else {
      ui.status.textContent = left > 0 ? `Count-in: ${left}…` : "Go!";
      setCurrent(offset);
      glideCursor(now);
    }
  }
  if (phase === "playing") {
    for (const j of e.tick(now)) view.mark(stepRefs[offset + j], markFor(e.results[j]));
    if (e.done) {
      finishTempo();
      return;
    }
    const j = Math.max(0, Math.min(seg.steps.length - 1, e.stepAt(now - (e.opts.latencyMs ?? 0))));
    setCurrent(offset + j);
    glideCursor(now);
    ui.status.textContent = `Measure ${measureOf(offset + j)} · ${Math.round(e.opts.bpm)} BPM`;
  }
  frame = requestAnimationFrame(tick);
}

function finishTempo() {
  player.stop();
  keepSegment();
  phase = "done";
  engine = null;
  keyboard.setTargets([]);
  view.hideCursor();
  showTransport();
  ui.status.textContent = "Done. Press Play (or Space) to go again.";
  finishRun();
  again();
}

function finishListen() {
  player.stop();
  phase = "done";
  if (shownCurrent >= 0) view.mark(stepRefs[shownCurrent], null);
  keyboard.setTargets([]);
  view.hideCursor();
  showTransport();
  ui.status.textContent = "Done. Press Play (or Space) to listen again.";
  again();
}

/** With "repeat the selection" on, go round again after a breath. */
function again() {
  if (!ui.loop.checked) return;
  ui.status.textContent += " Repeating…";
  loopTimer = setTimeout(() => {
    reset();
    if (mode !== "notes") void start(0);
  }, mode === "notes" ? 1200 : 2000);
}

// ---- Input -----------------------------------------------------------------------

function handleNote(ev: NoteEvent) {
  if (calibration.active) {
    if (ev.type === "on") calibration.tap(ev.t);
    if (ev.type === "on") keyboard.press(ev.midi, "neutral");
    else keyboard.release(ev.midi);
    return;
  }
  if (ev.type === "off") {
    keyboard.release(ev.midi);
    return;
  }
  const grading = engine && !engine.done && (mode === "notes" || phase === "countin" ||
    phase === "playing");
  if (!grading) {
    keyboard.press(ev.midi, "neutral");
    return;
  }
  const fb = engine!.input(ev);
  keyboard.press(ev.midi, fb.kind === "correct" ? "ok" : fb.kind === "wrong" ? "bad" : "neutral");
  if (fb.kind === "correct" && fb.stepDone) {
    const r = engine!.results[fb.step];
    view.mark(
      stepRefs[offset + fb.step],
      engine instanceof TempoEngine ? markFor(r) : r.clean ? "ok" : "bad",
    );
    if (engine instanceof NotesEngine) accompanyStep(offset + fb.step);
  }
  if (engine instanceof NotesEngine) {
    const done = engine.done;
    if (done) keepSegment();
    showProgress();
    if (done) {
      finishRun();
      again();
    }
  }
}

/**
 * Wait mode with "play the other hand": once a step is played, sound the
 * other hand's notes from there up to the next step, at the marked tempo.
 */
function accompanyStep(i: number) {
  if (!song || !practice || !ui.accompany.checked || ui.hands.value === "both") return;
  const from = practice.beats[i];
  const to = practice.beats[i + 1] ?? Infinity;
  const bpm = bpmAt(song.score.tempo, from);
  const notes = practice.accompaniment
    .filter((n) => n.beat >= from && n.beat < to && n.beat - from < 0.01)
    .map((n) => ({ midi: n.midi, dur: (n.quarters * 60000) / bpm }));
  void player.playNow(notes);
}

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
  const i = currentStep();
  const targets = practice && i >= 0 ? practice.steps[i].notes.map((n) => n.midi) : [];
  let midis = resolveOctave(p.pc, targets);
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
    ui.midiStatus.textContent = "Connect your instrument by USB or Bluetooth MIDI.";
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
  ui.midiStatus.textContent = devices.length === 1
    ? `Connected: ${devices[0].name}`
    : `${devices.length} devices`;
}

// ---- Results ---------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 100)}%`;

function stat(label: string, value: string): HTMLDivElement {
  const div = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

/** Score and record the run: every step attempted since the last reset. */
function finishRun() {
  if (!song || !practice || !attempted.size) return;
  const steps = [...attempted.keys()].sort((a, b) => a - b);
  const results = steps.map((k) => attempted.get(k)!);
  const bpm = (bpmAt(song.score.tempo, practice.beats[steps[0]]) * tempoPct()) / 100;
  const tolerance = mode === "tempo" ? Math.min(60, 60000 / bpm / 4) : 0;
  const s = summarize(mode === "tempo" ? "tempo" : "notes", results, tolerance);
  const stats = measureStats(
    { ...practice, events: steps.map((k) => practice!.events[k]) },
    results,
  );
  showResults(s, stats);
  ui.best.hidden = true;
  if (s.correct === 0 && s.wrongNotes === 0) return; // nothing was played
  const sel = selection();
  const t = s.timing;
  const run: Omit<SongSession, "id"> = {
    ts: Date.now(),
    songId: song.meta?.id ?? "unsaved",
    title: ui.title.value || "Untitled",
    hands: sel.hands,
    // A run started part way in counts from the measure it started in.
    from: Math.max(sel.from!, measureOf(steps[0])),
    to: sel.to!,
    mode: mode === "tempo" ? "tempo" : "notes",
    tempoPct: mode === "tempo" ? tempoPct() : 100,
    total: s.total,
    correct: s.correct,
    accuracy: s.accuracy,
    wrongNotes: s.wrongNotes,
    durationMs: Math.round(s.durationMs),
    timing: t && {
      onTime: t.onTime,
      early: t.early,
      late: t.late,
      missed: t.missed,
      meanAbsMs: t.meanAbsMs,
      meanSignedMs: t.meanSignedMs,
    },
    measures: stats.map((m) => ({ measure: m.measure, steps: m.steps, clean: m.clean })),
  };
  if (!song.meta) return; // not in the library: nothing to attach history to
  const { session, saved, previousBest } = store.addSong(run);
  void library?.update(song.meta.id, { lastPractised: run.ts }).then(renderLibrary);
  if (!saved) return;
  if (!previousBest) {
    ui.best.textContent = "First run of this practice recorded. See it under Progress.";
  } else if (betterSong(session, previousBest)) {
    ui.best.textContent = `New personal best, up from ${pct(previousBest.accuracy)}.`;
    ui.best.classList.add("new");
  } else {
    ui.best.textContent = `Your best for this practice is ${pct(previousBest.accuracy)}.`;
  }
  ui.best.hidden = false;
}

function showResults(s: Summary, stats: MeasureStat[]) {
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
    rows.push(stat("Time", `${(s.durationMs / 1000).toFixed(1)} s`));
  }
  ui.stats.replaceChildren(...rows);
  renderHeat(stats);
  const weak = weakestRange(stats, 2);
  ui.loopWeakest.hidden = !weak;
  if (weak) {
    ui.loopWeakest.textContent = weak.from === weak.to
      ? `Practise measure ${weak.from}`
      : `Practise measures ${weak.from}–${weak.to}`;
    ui.loopWeakest.onclick = () => setRange(weak.from, weak.to);
  }
  ui.resultsNote.textContent = t && t.meanSignedMs !== null &&
      Math.abs(t.meanSignedMs) > t.toleranceMs / 2
    ? (t.meanSignedMs < 0
      ? `You tended to rush, about ${Math.round(-t.meanSignedMs)} ms ahead of the beat.`
      : `You tended to drag, about ${
        Math.round(t.meanSignedMs)
      } ms behind the beat. If it felt on time, try raising the latency offset.`)
    : s.accuracy === 1
    ? "A clean run."
    : "";
  ui.results.hidden = false;
}

/** One square per measure, shaded by how much of it was clean. */
function renderHeat(stats: MeasureStat[]) {
  ui.heat.replaceChildren(...stats.map((m) => {
    const b = document.createElement("button");
    b.type = "button";
    const ratio = m.steps ? m.clean / m.steps : 1;
    // Five levels, so the colours come from the stylesheet (no inline
    // styles). Green is kept for measures with nothing wrong at all.
    b.className = `heat-cell level-${ratio === 1 ? 4 : Math.min(3, Math.floor(ratio * 4))}`;
    b.textContent = String(m.measure);
    const issues = [
      m.wrong ? `${m.wrong} wrong` : "",
      m.missed ? `${m.missed} missed` : "",
      m.early ? `${m.early} early` : "",
      m.late ? `${m.late} late` : "",
    ].filter(Boolean).join(", ");
    b.title = `Measure ${m.measure}: ${m.clean} of ${m.steps} clean${issues ? ` (${issues})` : ""}`;
    b.setAttribute("aria-label", b.title + ". Practise this measure.");
    b.addEventListener("click", () => setRange(m.measure, m.measure));
    return b;
  }));
}

function setRange(from: number, to: number) {
  ui.from.value = String(from);
  ui.to.value = String(to);
  persist();
  rebuild();
  ui.song.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Settings ---------------------------------------------------------------------

function restore() {
  const s = store.settings();
  if (s.songMode) ui.mode.value = s.songMode;
  if (s.songHands) ui.hands.value = s.songHands;
  if (s.songTempo) ui.tempo.value = String(s.songTempo);
  if (s.songMetronome !== undefined) ui.metronome.checked = s.songMetronome;
  if (s.songAccompany !== undefined) ui.accompany.checked = s.songAccompany;
  if (s.songLoop !== undefined) ui.loop.checked = s.songLoop;
  if (s.fingering !== undefined) ui.fingering.checked = s.fingering;
  if (s.latencyMs !== undefined) ui.latency.value = String(s.latencyMs);
}

function persist() {
  store.saveSettings({
    songMode: ui.mode.value as Mode,
    songHands: ui.hands.value as Selection["hands"],
    songTempo: tempoPct(),
    songMetronome: ui.metronome.checked,
    songAccompany: ui.accompany.checked,
    songLoop: ui.loop.checked,
    fingering: ui.fingering.checked,
    latencyMs: Math.min(300, Math.max(0, Number(ui.latency.value) || 0)),
  });
}

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
    persist();
  }
}

// ---- Wiring --------------------------------------------------------------------------

ui.form.addEventListener("change", (e) => {
  persist();
  const t = e.target as HTMLElement;
  if (t === ui.fingering) {
    view.setFingering(ui.fingering.checked);
    showTargets(currentStep());
    return;
  }
  if (t === ui.loop || t === ui.metronome || t === ui.latency) return; // read at Start
  rebuild();
});
ui.form.addEventListener("submit", (e) => e.preventDefault());
ui.calibrate.addEventListener("click", () => void calibrate());
ui.whole.addEventListener("click", () => {
  if (song) setRange(1, song.score.measureCount);
});
// After a resize or theme change OSMD redraws; put the current highlight back.
view.onRender = () => {
  if (phase === "idle" || engine instanceof NotesEngine) showProgress();
};
ui.title.addEventListener("change", () => {
  const title = ui.title.value.trim() || "Untitled";
  ui.title.value = title;
  if (song?.meta) {
    song.meta.title = title;
    void library?.update(song.meta.id, { title }).then(renderLibrary);
  }
});
for (
  const [b, run] of [
    [ui.start, togglePlay],
    [ui.stop, () => reset()],
    [ui.restart, restart],
    [ui.toStart, () => seek(0)],
    [ui.prevMeasure, () => skipMeasure(-1)],
    [ui.nextMeasure, () => skipMeasure(1)],
  ] as const
) {
  b.addEventListener("click", () => {
    run();
    b.blur();
  });
}
// A click on the score moves the play position there.
view.onSeek = (ref) => {
  if (practice) seek(stepOfRef(practice, ref));
};
ui.device.addEventListener("change", () => {
  midi.select(ui.device.value);
  const name = ui.device.selectedOptions[0]?.textContent;
  if (name && ui.device.value !== ALL_DEVICES) store.saveSettings({ device: name });
});

// Starter pieces are served with the site. Opening one adds a copy to the
// library (so its history works like any song's), or opens the copy
// already there.
for (const b of document.querySelectorAll<HTMLButtonElement>("button.starter")) {
  b.addEventListener("click", async () => {
    const file = b.dataset.file!;
    const existing = (await library?.list())?.find((s) => s.fileName === file);
    if (existing) {
      await openSong(existing.id);
      return;
    }
    setLibraryStatus("Loading…");
    try {
      const res = await fetch(b.dataset.src!);
      if (!res.ok) throw new Error(String(res.status));
      await addFile(new File([await res.arrayBuffer()], file, { type: "application/xml" }));
      ui.song.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      setLibraryStatus("That piece couldn't be loaded. Check your connection and try again.", true);
    }
  });
}

ui.upload.addEventListener("change", () => {
  const f = ui.upload.files?.[0];
  ui.upload.value = "";
  if (f) void addFile(f);
});
for (const type of ["dragenter", "dragover"]) {
  ui.dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    ui.dropZone.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  ui.dropZone.addEventListener(type, () => ui.dropZone.classList.remove("over"));
}
ui.dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) void addFile(f);
});

/** Set a form control and let its change handlers run, as if changed by hand. */
function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
const hasSong = () => !!song;
const toggleBox = (box: HTMLInputElement) => () => box.click();

const commands: Command[] = [
  {
    id: "play",
    label: "Play / pause",
    group: "Playback",
    shortcut: "Space",
    keywords: ["start", "resume", "listen"],
    enabled: () => hasSong() && mode !== "notes",
    run: togglePlay,
  },
  {
    id: "stop",
    label: "Stop",
    group: "Playback",
    shortcut: "Escape",
    enabled: hasSong,
    run: () => reset(),
  },
  {
    id: "restart",
    label: "Restart from the beginning",
    group: "Playback",
    shortcut: "R",
    enabled: hasSong,
    run: restart,
  },
  {
    id: "prev-measure",
    label: "Previous measure",
    group: "Navigate",
    shortcut: "ArrowLeft",
    repeatable: true,
    keywords: ["back", "rewind"],
    enabled: hasSong,
    run: () => skipMeasure(-1),
  },
  {
    id: "next-measure",
    label: "Next measure",
    group: "Navigate",
    shortcut: "ArrowRight",
    repeatable: true,
    keywords: ["forward", "skip"],
    enabled: hasSong,
    run: () => skipMeasure(1),
  },
  {
    id: "to-start",
    label: "Go to the start",
    group: "Navigate",
    shortcut: "Home",
    enabled: hasSong,
    run: () => seek(0),
  },
  {
    id: "whole",
    label: "Practise the whole piece",
    group: "Practice",
    keywords: ["measures", "range"],
    enabled: hasSong,
    run: () => ui.whole.click(),
  },
  {
    id: "weakest",
    label: "Practise the weakest measures",
    group: "Practice",
    enabled: () => !ui.loopWeakest.hidden && !ui.results.hidden,
    run: () => ui.loopWeakest.click(),
  },
  ...([
    ["notes", "Mode: wait for each note", ["wait"]],
    ["tempo", "Mode: play in time", ["tempo", "metronome"]],
    ["listen", "Mode: listen", ["hear", "playback"]],
  ] as const).map(([value, label, keywords]): Command => ({
    id: `mode.${value}`,
    label,
    group: "Practice",
    keywords: [...keywords],
    enabled: hasSong,
    run: () => choose(ui.mode, value),
  })),
  ...([["both", "Hands: both"], ["rh", "Hands: right only"], ["lh", "Hands: left only"]] as const)
    .map(([value, label]): Command => ({
      id: `hands.${value}`,
      label,
      group: "Practice",
      enabled: () => hasSong() && !ui.hands.disabled,
      run: () => choose(ui.hands, value),
    })),
  {
    id: "loop",
    label: "Repeat the selection on / off",
    group: "Practice",
    shortcut: "Alt+KeyL",
    keywords: ["loop"],
    run: toggleBox(ui.loop),
  },
  {
    id: "metronome",
    label: "Metronome on / off",
    group: "Practice",
    shortcut: "Alt+KeyM",
    keywords: ["click"],
    run: toggleBox(ui.metronome),
  },
  {
    id: "accompany",
    label: "Play the other hand on / off",
    group: "Practice",
    keywords: ["accompaniment"],
    run: toggleBox(ui.accompany),
  },
  {
    id: "fingering",
    label: "Show / hide fingers",
    group: "View",
    shortcut: "Alt+KeyN",
    keywords: ["fingering"],
    run: toggleBox(ui.fingering),
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
    id: "calibrate",
    label: "Measure latency",
    group: "Practice",
    keywords: ["calibrate", "offset", "delay"],
    run: () => void calibrate(),
  },
  ...[...document.querySelectorAll<HTMLButtonElement>("button.starter")].map((b): Command => ({
    id: `starter.${b.dataset.file}`,
    label: `Open ${b.querySelector(".song-name")?.textContent ?? b.dataset.file}`,
    group: "Practice",
    keywords: ["starter", "song", "piece"],
    run: () => b.click(),
  })),
];
/** Continuous (one line, scrolling) or page view, remembered. */
function setLineView(line: boolean) {
  view.setLineView(line);
  ui.viewToggle.setAttribute("aria-pressed", String(line));
  ui.viewToggle.title = line
    ? "Page view: wrap into lines (Alt+V)"
    : "Continuous view: one line, scrolling (Alt+V)";
  ui.viewToggle.setAttribute("aria-label", line ? "Page view" : "Continuous view");
  store.saveSettings({ songView: line ? "line" : "page" });
}
ui.viewToggle.addEventListener("click", () => {
  setLineView(ui.viewToggle.getAttribute("aria-pressed") !== "true");
  ui.viewToggle.blur();
});
setLineView(store.settings().songView === "line");
// ---- Big screen and zoom ------------------------------------------------------

/**
 * Big screen: the song section fills the window (and the screen, where the
 * browser allows fullscreen), the music taking most of it, the transport in
 * a bar along the bottom. Leaving fullscreen (the browser's Esc) leaves it too.
 */
function setBig(on: boolean) {
  if (on === ui.song.classList.contains("big")) return;
  ui.song.classList.toggle("big", on);
  document.body.classList.toggle("song-big", on);
  ui.big.setAttribute("aria-pressed", String(on));
  ui.big.setAttribute("aria-label", on ? "Leave big screen" : "Big screen");
  ui.big.title = on ? "Leave big screen (Esc or Alt+F)" : "Big screen (Alt+F)";
  if (on) {
    ui.song.requestFullscreen?.().catch(() => {});
  } else if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  }
  const i = currentStep();
  if (i >= 0) view.reveal(stepRefs[i][0]);
}
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) setBig(false);
});
ui.big.addEventListener("click", () => {
  setBig(!ui.song.classList.contains("big"));
  ui.big.blur();
});

let zoom = store.settings().songZoom ?? 1;
function setZoom(z: number) {
  zoom = Math.round(Math.min(2, Math.max(0.6, z)) * 10) / 10;
  view.setZoom(zoom);
  ui.zoomOut.disabled = zoom <= 0.6;
  ui.zoomIn.disabled = zoom >= 2;
  store.saveSettings({ songZoom: zoom });
}
ui.zoomIn.addEventListener("click", () => setZoom(zoom + 0.1));
ui.zoomOut.addEventListener("click", () => setZoom(zoom - 0.1));
setZoom(zoom);

// Esc also leaves the big screen.
const stopCommand = commands.find((c) => c.id === "stop")!;
stopCommand.run = () => {
  reset();
  setBig(false);
};
stopCommand.label = "Stop (and leave the big screen)";
stopCommand.enabled = () => hasSong() || ui.song.classList.contains("big");
commands.push(
  {
    id: "big",
    label: "Big screen on / off",
    group: "View",
    shortcut: "Alt+KeyF",
    keywords: ["fullscreen", "focus", "large"],
    enabled: hasSong,
    run: () => ui.big.click(),
  },
  {
    id: "zoom-in",
    label: "Bigger notes",
    group: "View",
    shortcut: "Alt+Equal",
    repeatable: true,
    keywords: ["zoom"],
    run: () => setZoom(zoom + 0.1),
  },
  {
    id: "zoom-out",
    label: "Smaller notes",
    group: "View",
    shortcut: "Alt+Minus",
    repeatable: true,
    keywords: ["zoom"],
    run: () => setZoom(zoom - 0.1),
  },
);
commands.push({
  id: "view",
  label: "Continuous / page view",
  group: "View",
  shortcut: "Alt+KeyV",
  keywords: ["scroll", "line", "no line breaks"],
  run: () => ui.viewToggle.click(),
});
installCommands([...siteCommands(), ...commands]);
ui.storageWarning.hidden = store.available;
sheetThemeToggle(el<HTMLButtonElement>("sheet-theme"), [ui.score], store);
restore();
showOptions();

midi.onDevices = showDevices;
midi.init().then((state) => {
  if (state === "ready") return;
  ui.device.replaceChildren(new Option("MIDI unavailable", ""));
  ui.device.disabled = true;
  ui.midiStatus.textContent = MIDI_MESSAGES[state];
  ui.midiStatus.classList.add("warn");
});

void SongLibrary.open().then(async (lib) => {
  library = lib;
  if (!lib) {
    setLibraryStatus(
      "This browser isn't letting the site keep files, so songs open but aren't saved.",
      true,
    );
    return;
  }
  await renderLibrary();
  const last = store.settings().lastSong;
  if (last && (await lib.get(last))) await openSong(last);
});

// Test hook: browser automation plays notes through the MIDI path and loads
// scores from text, since DevTools can provide neither a keyboard nor a file.
(globalThis as unknown as { __songs: unknown }).__songs = {
  note: (m: number, on = true, t = performance.now()) =>
    midi.onNote({ type: on ? "on" : "off", midi: m, velocity: 80, t }),
  targets: () => {
    const i = currentStep();
    return practice && i >= 0 ? practice.steps[i].notes.map((n) => n.midi) : [];
  },
  engine: () => engine,
  practice: () => practice,
  calibration,
  /** Due times of the playing segment's steps, keyed by step of the selection. */
  dueTimes: () => {
    const e = engine;
    return e instanceof TempoEngine
      ? Object.fromEntries(segment!.steps.map((_, j) => [offset + j, e.dueAt(j)]))
      : {};
  },
  position: () => currentStep(),
  phase: () => phase,
  seek,
  add: (text: string, name = "test.musicxml") =>
    addFile(new File([text], name, { type: "application/xml" })),
};
