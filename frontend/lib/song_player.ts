// Sound for the songs page: the count-in, the metronome clicks (following
// the piece's tempo map), and the notes the app plays itself (the other
// hand as accompaniment, or the whole selection in listen mode).
//
// Like the scales metronome, everything is timed on the audio clock and
// reported on the performance.now() clock note events use. A piece can
// have thousands of notes, so they are scheduled a little ahead of time
// in a loop rather than all at once.

import { audioToPerf } from "./metronome.ts";
import { msAt, type Practice, type Score } from "./score.ts";

export interface PlayNote {
  /** ms after the selection starts. */
  at: number;
  midi: number;
  dur: number;
}

export interface PlayPlan {
  /** Count-in clicks, ms relative to the start (negative). */
  countIn: number[];
  /** Metronome clicks from the start, ms. */
  clicks: number[];
  notes: PlayNote[];
  /** When the selection's last note ends, ms. */
  end: number;
}

export const COUNT_IN_BEATS = 4;

/**
 * What to play for a selection. `notes`: "other" plays the accompaniment
 * (notes the player isn't asked for), "all" every note (listen mode).
 */
export function playPlan(
  score: Score,
  p: Practice,
  opts: { pct: number; metronome: boolean; notes: "none" | "other" | "all"; countIn: boolean },
): PlayPlan {
  const t0 = msAt(score.tempo, p.startBeat, opts.pct);
  const at = (beat: number) => msAt(score.tempo, beat, opts.pct) - t0;
  const source = opts.notes === "all" ? p.all : opts.notes === "other" ? p.accompaniment : [];
  const notes = source.map((n) => ({
    at: at(n.beat),
    midi: n.midi,
    dur: Math.max(60, at(n.beat + n.quarters) - at(n.beat)),
  })).sort((a, b) => a.at - b.at);
  const lastBeat = Math.max(
    p.startBeat,
    ...p.all.map((n) => n.beat + n.quarters),
    ...p.beats.map((b) => b + 1),
  );
  const clicks: number[] = [];
  if (opts.metronome) {
    for (let b = Math.ceil(p.startBeat - 1e-9); b < lastBeat - 1e-9; b++) clicks.push(at(b));
  }
  const beatMs = at(p.startBeat + 1);
  const countIn = opts.countIn
    ? Array.from({ length: COUNT_IN_BEATS }, (_, k) => (k - COUNT_IN_BEATS) * beatMs)
    : [];
  return { countIn, clicks, notes, end: at(lastBeat) };
}

const LOOKAHEAD_S = 0.6;
const TICK_MS = 100;

export class SongPlayer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Start a plan. Returns when offset 0 falls on the performance.now()
   * clock, and when each count-in click sounds.
   */
  async start(plan: PlayPlan): Promise<{ startTime: number; countIn: number[] }> {
    this.stop();
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.connect(ctx.destination);
    this.out = out;

    const lead = 0.2 + (plan.countIn.length ? -plan.countIn[0] / 1000 : 0);
    const zero = ctx.currentTime + lead;
    plan.countIn.forEach((ms, k) => this.click(zero + ms / 1000, k === 0 ? 1760 : 1320, 0.5));

    let c = 0;
    let n = 0;
    const pump = () => {
      if (this.out !== out) return;
      const horizon = ctx.currentTime + LOOKAHEAD_S;
      while (c < plan.clicks.length && zero + plan.clicks[c] / 1000 < horizon) {
        this.click(zero + plan.clicks[c] / 1000, 880, 0.3);
        c++;
      }
      while (n < plan.notes.length && zero + plan.notes[n].at / 1000 < horizon) {
        const x = plan.notes[n];
        this.tone(zero + x.at / 1000, x.midi, x.dur / 1000);
        n++;
      }
    };
    pump();
    this.timer = setInterval(pump, TICK_MS);
    return {
      startTime: audioToPerf(ctx, zero),
      countIn: plan.countIn.map((ms) => audioToPerf(ctx, zero + ms / 1000)),
    };
  }

  /**
   * Sound notes now, outside any plan: wait mode plays the other hand as
   * each step is completed. Not silenced by stop(), so a chord rings out.
   */
  async playNow(notes: readonly { midi: number; dur: number }[]) {
    if (!notes.length) return;
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const out = this.ctx.createGain();
    out.connect(this.ctx.destination);
    const at = this.ctx.currentTime + 0.01;
    for (const n of notes) this.tone(at, n.midi, n.dur / 1000, out);
  }

  /**
   * One click at `perfTime` (performance.now() ms), on the output of the
   * plan started last: the following guide click schedules its beats one
   * at a time, just ahead. A time already past is skipped. Returns whether
   * it was scheduled.
   */
  clickAt(perfTime: number): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.out) return false;
    const now = ctx.currentTime;
    const at = now + (perfTime - audioToPerf(ctx, now)) / 1000;
    if (at < now) return false;
    this.click(at, 880, 0.3);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    // Disconnecting the output silences everything already scheduled.
    this.out?.disconnect();
    this.out = null;
  }

  private click(at: number, freq: number, level: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(this.out!);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  /** A soft piano-like tone: quick attack, decay to a sustain, release at the end. */
  private tone(at: number, midi: number, dur: number, dest: AudioNode = this.out!) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    const len = Math.max(0.08, dur);
    const end = at + len;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.16, at + 0.01);
    // The decay ends well before the release starts, so the events stay in order.
    gain.gain.exponentialRampToValueAtTime(0.05, at + Math.min(0.5, len * 0.6));
    gain.gain.setValueAtTime(0.05, end - 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.12);
    osc.connect(gain).connect(dest);
    osc.start(at);
    osc.stop(end + 0.15);
  }
}
