// Grading. Two engines share one shape: notes-only (the cursor waits for
// you) and tempo (the metronome moves on whether you played or not). Both
// are pure: they take timestamped note events and return what happened, and
// the page decides how to show it. Times are milliseconds on one clock — the
// page uses performance.now(), which is also what MIDIMessageEvent.timeStamp
// is measured on.

import type { Step } from "./theory.ts";

export interface NoteEvent {
  type: "on" | "off";
  midi: number;
  velocity: number;
  t: number;
}

export type Feedback =
  /** An expected note. stepDone when it completed its step. */
  | { kind: "correct"; midi: number; step: number; stepDone: boolean }
  /** Not a note the current step wants. */
  | { kind: "wrong"; midi: number; step: number }
  /** A repeat of an already-counted note, a note-off, or input after the end. */
  | { kind: "ignored"; midi: number };

export type Grade = "on" | "early" | "late";

export interface StepResult {
  index: number;
  status: "pending" | "ok" | "missed";
  /** Completed with no wrong note while it was the current step. */
  clean: boolean;
  wrong: number[];
  /** Onset of each expected note, parallel to Step.notes (null = not played). */
  onsets: (number | null)[];
  velocities: number[];
  /** Spread between the hands' onsets, for hands together. */
  asyncMs: number | null;
  /** Tempo mode: mean signed deviation from the beat (negative = early). */
  deviationMs: number | null;
  grade: Grade | null;
}

export interface TimingSummary {
  onTime: number;
  early: number;
  late: number;
  missed: number;
  meanAbsMs: number | null;
  /** Positive = dragging behind the beat, negative = rushing. */
  meanSignedMs: number | null;
  toleranceMs: number;
  deviations: (number | null)[];
}

export interface Summary {
  mode: "notes" | "tempo";
  total: number;
  correct: number;
  /** correct / total, 0–1. */
  accuracy: number;
  wrongNotes: number;
  durationMs: number;
  /**
   * How uneven the spacing between step onsets was, relative to its typical
   * size: 0 is metronomic. The interquartile range of the gaps over their
   * median, rather than a coefficient of variation, so one hesitation in an
   * otherwise steady run does not swamp it (a quarter of the gaps can be
   * outliers), while spacing that is ragged throughout still scores badly.
   * Null with fewer than three onsets.
   */
  unevenness: number | null;
  /** Standard deviation of the velocities of correct notes (0–127 scale). */
  velocityStd: number | null;
  /** Hands-together steps whose hands were more than NOT_TOGETHER_MS apart. */
  notTogether: number;
  timing: TimingSummary | null;
}

/** Hands this far apart no longer sound like one event. */
export const NOT_TOGETHER_MS = 80;

export interface Engine {
  readonly steps: readonly Step[];
  readonly results: readonly StepResult[];
  readonly done: boolean;
  input(ev: NoteEvent): Feedback;
  summary(): Summary;
}

function freshResults(steps: readonly Step[]): StepResult[] {
  return steps.map((s) => ({
    index: s.index,
    status: "pending",
    clean: true,
    wrong: [],
    onsets: s.notes.map(() => null),
    velocities: [],
    asyncMs: null,
    deviationMs: null,
    grade: null,
  }));
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Linear-interpolated quantile, q in [0, 1]. */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

export const median = (xs: number[]) => quantile(xs, 0.5);

export function std(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

function spread(onsets: (number | null)[]): number | null {
  const ts = onsets.filter((t): t is number => t !== null);
  return ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : null;
}

/** Shared metrics over whichever steps were played. */
function baseSummary(mode: Summary["mode"], results: readonly StepResult[]) {
  const firstOnsets = results
    .map((r) => {
      const ts = r.onsets.filter((t): t is number => t !== null);
      return ts.length ? Math.min(...ts) : null;
    })
    .filter((t): t is number => t !== null);
  const gaps = firstOnsets.slice(1).map((t, i) => t - firstOnsets[i]);
  const gapMedian = median(gaps);
  const allOnsets = results.flatMap((r) => r.onsets.filter((t): t is number => t !== null));
  const correct = results.filter((r) => r.status === "ok" && r.clean).length;
  return {
    mode,
    total: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    wrongNotes: results.reduce((a, r) => a + r.wrong.length, 0),
    durationMs: allOnsets.length ? Math.max(...allOnsets) - Math.min(...allOnsets) : 0,
    unevenness: gapMedian && gaps.length >= 2
      ? (quantile(gaps, 0.75)! - quantile(gaps, 0.25)!) / gapMedian
      : null,
    velocityStd: std(results.flatMap((r) => r.velocities)),
    notTogether: results.filter((r) => r.asyncMs !== null && r.asyncMs > NOT_TOGETHER_MS)
      .length,
  };
}

/**
 * Notes-only: the cursor waits on the current step until every note of it
 * has been played, in any order. A wrong note is counted against the step
 * and the cursor stays put, so the run always ends on the last note.
 */
export class NotesEngine implements Engine {
  readonly results: StepResult[];
  cursor = 0;

  constructor(readonly steps: readonly Step[]) {
    this.results = freshResults(steps);
  }

  get done(): boolean {
    return this.cursor >= this.steps.length;
  }

  input(ev: NoteEvent): Feedback {
    if (ev.type !== "on" || this.done) {
      return { kind: "ignored", midi: ev.midi };
    }
    const step = this.steps[this.cursor];
    const r = this.results[this.cursor];
    const i = step.notes.findIndex((n) => n.midi === ev.midi);
    if (i < 0) {
      r.wrong.push(ev.midi);
      r.clean = false;
      return { kind: "wrong", midi: ev.midi, step: this.cursor };
    }
    if (r.onsets[i] !== null) return { kind: "ignored", midi: ev.midi };

    r.onsets[i] = ev.t;
    r.velocities.push(ev.velocity);
    const index = this.cursor;
    const stepDone = r.onsets.every((t) => t !== null);
    if (stepDone) {
      r.status = "ok";
      r.asyncMs = spread(r.onsets);
      this.cursor++;
    }
    return { kind: "correct", midi: ev.midi, step: index, stepDone };
  }

  summary(): Summary {
    return { ...baseSummary("notes", this.results), timing: null };
  }
}

export interface TempoOptions {
  bpm: number;
  notesPerBeat: number;
  /** When step 0 is due, on the event clock (i.e. after the count-in). */
  startTime: number;
  /**
   * Subtracted from every event time before grading: the measured delay
   * between hearing a click and the instrument's report arriving.
   */
  latencyMs?: number;
  /**
   * When each step is due, in ms after startTime, strictly increasing. A
   * piece of music has uneven note lengths; without this, steps are evenly
   * spaced at 60000 / bpm / notesPerBeat (scales). bpm and notesPerBeat are
   * then only descriptive.
   */
  offsets?: readonly number[];
}

/**
 * Tempo: step i is due at startTime + i × interval (or at its offset). Each
 * note is matched to the step whose window it falls in, which reaches half
 * way to the neighbouring steps; it counts if that step wants it. Steps
 * whose window passes unplayed are missed — call tick() as time advances so
 * the page can show them.
 */
export class TempoEngine implements Engine {
  readonly results: StepResult[];
  /** The step spacing; with offsets, the typical (median) gap. */
  readonly interval: number;
  /** The on-the-beat tolerance; with offsets, the typical one. */
  readonly tolerance: number;
  private finalized = 0;
  private readonly latency: number;
  private readonly offsets: readonly number[] | null;

  constructor(readonly steps: readonly Step[], readonly opts: TempoOptions) {
    if (opts.bpm <= 0 || opts.notesPerBeat <= 0) {
      throw new RangeError("bpm and notesPerBeat must be positive");
    }
    const off = opts.offsets ?? null;
    if (off) {
      if (off.length !== steps.length) throw new RangeError("one offset per step");
      if (off.some((x, i) => i > 0 && x <= off[i - 1])) {
        throw new RangeError("offsets must be strictly increasing");
      }
    }
    this.offsets = off;
    this.results = freshResults(steps);
    const gaps = off ? off.slice(1).map((x, i) => x - off[i]) : [];
    this.interval = off
      ? median(gaps) ?? 60000 / opts.bpm / opts.notesPerBeat
      : 60000 / opts.bpm / opts.notesPerBeat;
    this.tolerance = Math.min(60, this.interval / 4);
    this.latency = opts.latencyMs ?? 0;
  }

  dueAt(i: number): number {
    return this.opts.startTime + (this.offsets ? this.offsets[i] : i * this.interval);
  }

  /** Gap to the previous and next step (the outer steps borrow their one neighbour). */
  private gaps(i: number): [before: number, after: number] {
    if (!this.offsets || this.steps.length < 2) return [this.interval, this.interval];
    const last = this.steps.length - 1;
    const before = i > 0 ? this.dueAt(i) - this.dueAt(i - 1) : this.dueAt(1) - this.dueAt(0);
    const after = i < last ? this.dueAt(i + 1) - this.dueAt(i) : before;
    return [i > 0 ? before : after, after];
  }

  /**
   * How close to its time step i must be to count as on the beat: 60 ms is
   * comfortable at moderate tempi, but at fast notes it would swallow a
   * quarter of the gap, so it scales down with the gaps around the step.
   */
  toleranceAt(i: number): number {
    const [before, after] = this.gaps(i);
    return Math.min(60, Math.min(before, after) / 4);
  }

  /** When step i's window closes: half way to the next step. */
  private windowEnd(i: number): number {
    return this.dueAt(i) + this.gaps(i)[1] / 2;
  }

  /** The step whose window contains t (may be out of range: -1 or length). */
  stepAt(t: number): number {
    if (!this.offsets) return Math.round((t - this.opts.startTime) / this.interval);
    const n = this.steps.length;
    if (!n || t < this.dueAt(0) - this.gaps(0)[0] / 2) return -1;
    if (t > this.windowEnd(n - 1)) return n;
    // The first step whose window has not closed by t.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.windowEnd(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** When the last step's window closes. */
  get endTime(): number {
    return this.windowEnd(this.steps.length - 1);
  }

  get done(): boolean {
    return this.finalized >= this.steps.length;
  }

  input(ev: NoteEvent): Feedback {
    if (ev.type !== "on") return { kind: "ignored", midi: ev.midi };
    const t = ev.t - this.latency;
    const i = this.stepAt(t);
    if (i < 0 || i >= this.steps.length || i < this.finalized) {
      // Before the first window, after the last, or in a window already
      // closed by tick(): a stray note, but still a wrong one if the run is
      // under way.
      if (i >= 0 && i < this.steps.length) {
        this.results[i].wrong.push(ev.midi);
        this.results[i].clean = false;
        return { kind: "wrong", midi: ev.midi, step: i };
      }
      return { kind: "ignored", midi: ev.midi };
    }
    const r = this.results[i];
    const n = this.steps[i].notes.findIndex((x) => x.midi === ev.midi);
    if (n < 0) {
      r.wrong.push(ev.midi);
      r.clean = false;
      return { kind: "wrong", midi: ev.midi, step: i };
    }
    if (r.onsets[n] !== null) return { kind: "ignored", midi: ev.midi };
    r.onsets[n] = t;
    r.velocities.push(ev.velocity);
    const stepDone = r.onsets.every((x) => x !== null);
    if (stepDone) this.grade(i);
    return { kind: "correct", midi: ev.midi, step: i, stepDone };
  }

  private grade(i: number) {
    const r = this.results[i];
    const due = this.dueAt(i);
    const devs = r.onsets.filter((x): x is number => x !== null).map((x) => x - due);
    r.status = "ok";
    r.asyncMs = spread(r.onsets);
    r.deviationMs = mean(devs);
    const d = r.deviationMs!;
    r.grade = Math.abs(d) <= this.toleranceAt(i) ? "on" : d < 0 ? "early" : "late";
  }

  /**
   * Close every window that has passed by `now`, marking unfinished steps
   * missed. Returns the indices closed by this call.
   */
  tick(now: number): number[] {
    const closed: number[] = [];
    const t = now - this.latency;
    while (
      this.finalized < this.steps.length &&
      this.windowEnd(this.finalized) < t
    ) {
      const r = this.results[this.finalized];
      if (r.status !== "ok") {
        // A partly played hands-together step is still a miss: half a
        // chord is not the chord.
        r.status = "missed";
        r.clean = false;
      }
      closed.push(this.finalized);
      this.finalized++;
    }
    return closed;
  }

  summary(): Summary {
    const base = baseSummary("tempo", this.results);
    const graded = this.results.filter((r) => r.status === "ok");
    const devs = graded.map((r) => r.deviationMs!);
    const absMean = mean(devs.map(Math.abs));
    return {
      ...base,
      durationMs: this.results.length ? this.endTime - this.opts.startTime : 0,
      timing: {
        onTime: graded.filter((r) => r.grade === "on").length,
        early: graded.filter((r) => r.grade === "early").length,
        late: graded.filter((r) => r.grade === "late").length,
        missed: this.results.filter((r) => r.status !== "ok").length,
        meanAbsMs: absMean,
        meanSignedMs: mean(devs),
        toleranceMs: this.tolerance,
        deviations: this.results.map((r) => r.deviationMs),
      },
    };
  }
}
