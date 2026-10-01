// The metronome for tempo mode: a one-bar count-in, then a click on every
// beat of the exercise. Every click is scheduled on the audio clock up
// front, which is sample-accurate; setTimeout-driven clicks drift by
// tens of milliseconds, which is the size of what tempo mode grades.

export const BEATS_PER_BAR = 4;

export interface Schedule {
  /** performance.now() time at which step 0 is due. */
  startTime: number;
  /** performance.now() time of each count-in click. */
  countIn: number[];
}

/**
 * Pure timing: when (on the audio clock, seconds) each count-in click and
 * each beat click falls, given when the first count-in click sounds.
 */
export function clickTimes(
  first: number,
  bpm: number,
  notesPerBeat: number,
  steps: number,
): { countIn: number[]; beats: number[]; stepZero: number } {
  const beat = 60 / bpm;
  const countIn = Array.from({ length: BEATS_PER_BAR }, (_, k) => first + k * beat);
  const stepZero = first + BEATS_PER_BAR * beat;
  const beatCount = Math.ceil(steps / notesPerBeat);
  const beats = Array.from({ length: beatCount }, (_, k) => stepZero + k * beat);
  return { countIn, beats, stepZero };
}

/**
 * Map an audio-clock time to performance.now(). getOutputTimestamp pairs
 * the two clocks at the moment a sample actually leaves the speakers, so
 * the mapping includes output latency: the result is when a sound is
 * *heard*, which is what a player aligns to.
 */
export function audioToPerf(ctx: AudioContext, audioTime: number): number {
  const ts = ctx.getOutputTimestamp();
  if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
    return ts.performanceTime + (audioTime - ts.contextTime) * 1000;
  }
  // Fallback: assume "now" on both clocks, plus the reported latency.
  return performance.now() + (audioTime - ctx.currentTime + (ctx.outputLatency || 0)) * 1000;
}

export class Metronome {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;

  /**
   * Schedule a run and return its timing on the performance.now() clock,
   * the one note events are stamped with.
   */
  async start(bpm: number, notesPerBeat: number, steps: number): Promise<Schedule> {
    this.stop();
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const ctx = this.ctx;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);

    // A short margin so the first click is never scheduled in the past.
    const { countIn, beats, stepZero } = clickTimes(
      ctx.currentTime + 0.2,
      bpm,
      notesPerBeat,
      steps,
    );
    countIn.forEach((t, k) => this.click(t, k === 0 ? 1760 : 1320, 0.5));
    beats.forEach((t, k) => this.click(t, k % BEATS_PER_BAR === 0 ? 1320 : 880, 0.35));

    return { startTime: this.toPerf(stepZero), countIn: countIn.map((t) => this.toPerf(t)) };
  }

  stop() {
    // Disconnecting the shared output silences every click already
    // scheduled, without tracking each oscillator.
    this.out?.disconnect();
    this.out = null;
  }

  private toPerf(audioTime: number): number {
    return audioToPerf(this.ctx!, audioTime);
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
}
