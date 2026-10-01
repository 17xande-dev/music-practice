// Turns pitch frames from the detector into note events: the same NoteEvent
// the MIDI input produces, so grading, the staff and the results work for
// guitar unchanged.
//
// A frame is one detector window (~43 ms of audio, every ~5 ms). A note is:
//   - started by an attack (a quick rise in level: a pluck) or by a new pitch
//     that holds (a legato hammer-on or slide);
//   - confirmed once the same semitone holds for a few frames, and stamped
//     with the time of its attack, not of the confirmation, so tempo grading
//     sees when the string was struck;
//   - ended when the level falls through the gate, when the string is
//     plucked again, or when a different pitch takes over.
// A pitch must hold to count, so a single stray frame (an octave flicker as
// a note decays, say) changes nothing.
//
// Known limit: the same note re-plucked very fast (16ths at 120 BPM) while
// it still rings is not seen as a new note; the attack is masked. Scale
// exercises never repeat a pitch back to back, so grading is unaffected.

import type { NoteEvent } from "./engine.ts";
import { amplitudeToDb, freqToMidi, type PitchFrame } from "./pitch.ts";

export interface TimedFrame extends PitchFrame {
  /** performance.now() milliseconds for the end of the frame's window. */
  t: number;
  /**
   * Onset strength for the newest few milliseconds (see onsetStrength).
   * Optional: without it, plucks are found from the window level alone,
   * which misses a fast re-pluck of a note that is still ringing.
   */
  onset?: number;
}

/** Samples of the newest audio the onset strength looks at (~10 ms at 48 kHz). */
export const ONSET_SAMPLES = 512;

/**
 * "High-frequency content" onset strength: the RMS of the signal's first
 * difference over the newest ONSET_SAMPLES. A pick's attack is a broadband
 * burst that differencing keeps; a sustained note's low fundamental it
 * mostly removes. A plain short-window RMS would not do: shorter than one
 * period of low E (12 ms), it swings with the waveform's phase and would
 * report attacks in the middle of a held note.
 */
export function onsetStrength(window: Float32Array | Float64Array): number {
  const n = Math.min(ONSET_SAMPLES, window.length - 1);
  let sum = 0;
  for (let i = window.length - n; i < window.length; i++) {
    const d = window[i] - window[i - 1];
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

export interface TrackerOptions {
  /** Level that opens the gate (dBFS). */
  gateOnDb?: number;
  /** Level that closes it again; below gateOnDb, so it doesn't chatter. */
  gateOffDb?: number;
  /** Window-level rise that counts as a new pluck, without an onset strength (dB). */
  onsetJumpDb?: number;
  /**
   * Onset-strength rise that counts as a pluck (dB), against the median of
   * recent frames (so one-frame dips of a ringing note don't count).
   */
  onsetStrengthJumpDb?: number;
  /**
   * After a pluck, pitch frames are ignored for this long (ms): the
   * detector's window still holds mostly the previous note, which would
   * otherwise be confirmed again as a new note before the real one appears.
   */
  settleMs?: number;
  /**
   * With an onset strength, the window level must also rise at least this
   * much (dB). A real pluck adds energy; a ringing note only decays, so its
   * onset-strength wobble alone never counts.
   */
  windowRiseDb?: number;
  /** Consecutive frames a pitch must hold before it is a note. */
  stableFrames?: number;
  /** Frames an octave jump must hold: octave flickers are the classic error. */
  octaveFrames?: number;
  minClarity?: number;
  /**
   * After a pluck, no new pluck for this long (ms). The level keeps rising
   * for a frame or two after an attack while the window still holds the
   * quiet before it, which would otherwise read as more plucks and keep
   * pushing the onset later. 60 ms is under the gap between 16th notes at
   * 160 BPM (94 ms).
   */
  refractoryMs?: number;
  /** Reference tuning. */
  a4?: number;
}

interface Candidate {
  midi: number;
  count: number;
  firstT: number;
  peakDb: number;
}

function median(xs: number[]): number {
  if (!xs.length) return -Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Map a level to MIDI velocity: about −50 dBFS → 1, −6 dBFS → 127. */
export function velocityFor(db: number): number {
  return Math.max(1, Math.min(127, Math.round(((db + 50) / 44) * 126 + 1)));
}

export class NoteTracker {
  private readonly gateOn: number;
  private readonly gateOff: number;
  private readonly jump: number;
  private readonly onsetJump: number;
  private readonly rise: number;
  private readonly stable: number;
  private readonly octave: number;
  private readonly minClarity: number;
  private readonly a4: number;
  private readonly refractory: number;
  private readonly settle: number;

  private gateOpen = false;
  private active: { midi: number } | null = null;
  private candidate: Candidate | null = null;
  /** Time of an attack not yet claimed by a note. */
  private attackT: number | null = null;
  private recentDb: number[] = [];
  private recentWindowDb: number[] = [];
  private lastAttackT = -Infinity;

  constructor(opts: TrackerOptions = {}) {
    this.gateOn = opts.gateOnDb ?? -45;
    this.gateOff = opts.gateOffDb ?? -52;
    this.jump = opts.onsetJumpDb ?? 6;
    this.onsetJump = opts.onsetStrengthJumpDb ?? 6;
    this.rise = opts.windowRiseDb ?? 1;
    this.stable = opts.stableFrames ?? 3;
    this.octave = opts.octaveFrames ?? 6;
    this.minClarity = opts.minClarity ?? 0.9;
    this.a4 = opts.a4 ?? 440;
    this.refractory = opts.refractoryMs ?? 60;
    this.settle = opts.settleMs ?? 25;
  }

  /** The note currently sounding, if any. */
  get current(): number | null {
    return this.active?.midi ?? null;
  }

  push(f: TimedFrame): NoteEvent[] {
    const out: NoteEvent[] = [];
    const db = amplitudeToDb(f.rms);
    // Attacks are judged on the onset strength when there is one, the
    // window level otherwise.
    const level = f.onset === undefined ? db : amplitudeToDb(f.onset);
    // Rises are measured against the median of the last few frames, so a
    // single-frame dip doesn't make the next ordinary frame look like a jump.
    const floor = median(this.recentDb);
    const windowFloor = median(this.recentWindowDb);
    this.recentDb.push(level);
    this.recentWindowDb.push(db);
    if (this.recentDb.length > 6) this.recentDb.shift();
    if (this.recentWindowDb.length > 6) this.recentWindowDb.shift();
    const rising = f.onset === undefined || db - windowFloor >= this.rise;

    // Gate, with hysteresis.
    this.gateOpen = this.gateOpen ? db > this.gateOff : db > this.gateOn;
    if (!this.gateOpen) {
      this.endActive(out, f.t);
      this.candidate = null;
      this.attackT = null;
      return out;
    }

    // A pluck: the level jumps well above where it was a moment ago. A pluck
    // during a note ends that note, even on the same pitch — the re-pluck
    // must be a new note.
    if (
      level - floor >= (f.onset === undefined ? this.jump : this.onsetJump) && rising &&
      db > this.gateOn &&
      f.t - this.lastAttackT >= this.refractory
    ) {
      this.attackT = f.t;
      this.lastAttackT = f.t;
      this.endActive(out, f.t);
      this.candidate = null;
    }

    if (f.freq <= 0 || f.clarity < this.minClarity) return out;
    if (this.attackT !== null && f.t - this.attackT < this.settle) return out;
    const midi = Math.round(freqToMidi(f.freq, this.a4));

    if (this.active && midi === this.active.midi) {
      this.candidate = null; // sustaining; any rival pitch was a flicker
      return out;
    }

    const c = this.candidate;
    if (c && c.midi === midi) {
      c.count++;
      c.peakDb = Math.max(c.peakDb, db);
    } else {
      this.candidate = { midi, count: 1, firstT: this.attackT ?? f.t, peakDb: db };
    }
    const cand = this.candidate!;
    const needed = this.active && Math.abs(midi - this.active.midi) === 12
      ? this.octave
      : this.stable;
    if (cand.count >= needed) {
      // A new pitch has taken over (legato), or the first pitch after a pluck.
      this.endActive(out, cand.firstT);
      out.push({ type: "on", midi: cand.midi, velocity: velocityFor(cand.peakDb), t: cand.firstT });
      this.active = { midi: cand.midi };
      this.candidate = null;
      this.attackT = null;
    }
    return out;
  }

  /** End any sounding note now (e.g. when input stops). */
  flush(t: number): NoteEvent[] {
    const out: NoteEvent[] = [];
    this.endActive(out, t);
    this.candidate = null;
    return out;
  }

  private endActive(out: NoteEvent[], t: number) {
    if (!this.active) return;
    out.push({ type: "off", midi: this.active.midi, velocity: 0, t });
    this.active = null;
  }
}
