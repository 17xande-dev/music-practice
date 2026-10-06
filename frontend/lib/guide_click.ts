// A guide click that follows the player, for rubato. Pure: it says when
// the next click should sound, and the page schedules it.
//
// Each click falls where the player's next beat would land: measured from
// the last note they played (its time and its beat in the score), at the
// player's tempo. That tempo moves only part of the way towards each new
// estimate, so one late note doesn't lurch the click. If the player stops
// (past where the next note was due, plus a couple of beats) the click
// waits, and picks up again from their next note.
//
// Beats are quarter notes, as the score model counts them.

export interface FollowOptions {
  /** How far towards each new tempo estimate the click moves (0–1). */
  smoothing: number;
  /** Beats of silence past the next note's due beat before the click waits. */
  pauseBeats: number;
}

export const FOLLOW_DEFAULTS: FollowOptions = { smoothing: 0.35, pauseBeats: 2 };

export interface Click {
  beat: number;
  /** performance.now() ms. */
  t: number;
}

export class FollowingClick {
  private anchorT: number;
  private anchorBeat: number;
  /** The last beat that clicks may reach before the next note comes. */
  private limitBeat: number;
  private lastBeat = -Infinity;
  private readonly opts: FollowOptions;

  /**
   * `beatMs`: the starting beat length (the marked tempo, as the count-in
   * played it). `start`: when and on which beat the music begins.
   * `startBeats`: how long to keep clicking if the player hasn't started.
   */
  constructor(
    public beatMs: number,
    start: Click,
    opts: Partial<FollowOptions> = {},
    startBeats = 8,
  ) {
    this.opts = { ...FOLLOW_DEFAULTS, ...opts };
    this.anchorT = start.t;
    this.anchorBeat = start.beat;
    this.limitBeat = start.beat + startBeats;
  }

  /**
   * The player played the note on `beat` at time `t`. `targetBeatMs` is
   * their tempo as estimated now (null while it isn't known yet), and
   * `nextBeat` the beat of the next note, to know how long to wait for it.
   */
  onNote(beat: number, t: number, targetBeatMs: number | null, nextBeat: number) {
    if (targetBeatMs !== null && targetBeatMs > 0) {
      this.beatMs += this.opts.smoothing * (targetBeatMs - this.beatMs);
    }
    this.anchorT = t;
    this.anchorBeat = beat;
    this.limitBeat = Math.max(beat, nextBeat) + this.opts.pauseBeats;
  }

  /** The next click not yet taken, or null while waiting for the player. */
  next(): Click | null {
    const beat = Math.max(Math.ceil(this.anchorBeat - 1e-6), this.lastBeat + 1);
    if (beat > this.limitBeat + 1e-6) return null;
    return { beat, t: this.anchorT + (beat - this.anchorBeat) * this.beatMs };
  }

  /** Mark a click as scheduled (or skipped), so next() moves on. */
  take(beat: number) {
    this.lastBeat = Math.max(this.lastBeat, beat);
  }
}
