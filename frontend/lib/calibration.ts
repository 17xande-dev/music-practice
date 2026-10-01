// Measuring the latency offset instead of guessing it. The page plays a
// short run of clicks and the player taps along on their instrument; the
// typical gap between each click being heard and the tap arriving is the
// delay the tempo grading should subtract (the instrument's own latency,
// USB, and for guitar the pitch detector's reaction time).
//
// The clicks are timed as heard (the metronome maps the audio clock to
// performance.now() including output latency), and taps carry the times
// the page receives them, so the gap is exactly what tempo mode sees.

import { median, quantile } from "./engine.ts";
import type { Metronome } from "./metronome.ts";

export const CALIBRATION_BPM = 90;
/** Clicks after the count-in; taps during the count-in count too. */
export const CALIBRATION_CLICKS = 8;
/** A tap further than this from every click isn't an attempt at one. */
const MATCH_MS = 250;
const MIN_TAPS = 5;
/** Taps scattered wider than this (interquartile range) aren't a measurement. */
const MAX_SPREAD_MS = 60;

export type LatencyResult =
  | { ok: true; offsetMs: number; setting: number; taps: number; spreadMs: number }
  | { ok: false; reason: "few" | "uneven"; taps: number; spreadMs: number | null };

/**
 * Match each click to the first tap near it, and take the median gap.
 * The setting is rounded to 5 ms and kept within the field's 0–300 ms:
 * taps landing early on average mean no delay to correct.
 */
export function estimateLatency(clicks: readonly number[], taps: readonly number[]): LatencyResult {
  const gaps: number[] = [];
  const used = new Set<number>();
  for (const c of clicks) {
    const i = taps.findIndex((t, k) => !used.has(k) && Math.abs(t - c) <= MATCH_MS);
    if (i < 0) continue;
    used.add(i);
    gaps.push(taps[i] - c);
  }
  const spreadMs = gaps.length >= 2 ? quantile(gaps, 0.75)! - quantile(gaps, 0.25)! : null;
  if (gaps.length < MIN_TAPS) return { ok: false, reason: "few", taps: gaps.length, spreadMs };
  if (spreadMs! > MAX_SPREAD_MS) {
    return { ok: false, reason: "uneven", taps: gaps.length, spreadMs };
  }
  const offsetMs = median(gaps)!;
  const setting = Math.min(300, Math.max(0, Math.round(offsetMs / 5) * 5));
  return { ok: true, offsetMs, setting, taps: gaps.length, spreadMs: spreadMs! };
}

/** What to tell the player about a result. */
export function describeLatency(r: LatencyResult): string {
  if (!r.ok && r.reason === "few") {
    return `Only ${r.taps} tap${r.taps === 1 ? "" : "s"} landed near the clicks. ` +
      "Try again, tapping a key along with every click.";
  }
  if (!r.ok) {
    return `The taps were uneven (spread ±${Math.round(r.spreadMs! / 2)} ms). ` +
      "Try again, keeping as steady as you can.";
  }
  const how = r.offsetMs < 0
    ? `Your taps landed ${Math.round(-r.offsetMs)} ms ahead of the clicks, so no offset is needed.`
    : `Your taps arrived ${Math.round(r.offsetMs)} ms after the clicks.`;
  return `${how} Latency offset set to ${r.setting} ms.`;
}

/** Runs the clicks and collects taps; the page passes note-ons to tap(). */
export class Calibration {
  private taps: number[] = [];
  /** When each click of the current run sounds (performance.now() ms). */
  clicks: number[] = [];
  active = false;

  constructor(private readonly metronome: Metronome) {}

  async run(): Promise<LatencyResult> {
    this.taps = [];
    this.active = true;
    try {
      const s = await this.metronome.start(CALIBRATION_BPM, 1, CALIBRATION_CLICKS);
      const beat = 60000 / CALIBRATION_BPM;
      const clicks = this.clicks = [
        ...s.countIn,
        ...Array.from({ length: CALIBRATION_CLICKS }, (_, k) => s.startTime + k * beat),
      ];
      const end = clicks.at(-1)! + MATCH_MS + 100;
      await new Promise((r) => setTimeout(r, Math.max(0, end - performance.now())));
      return estimateLatency(clicks, this.taps);
    } finally {
      this.active = false;
      this.metronome.stop();
    }
  }

  /** A tap (note-on) at time t, on the performance.now() clock. */
  tap(t: number) {
    if (this.active) this.taps.push(t);
  }

  cancel() {
    this.active = false;
    this.metronome.stop();
  }
}
