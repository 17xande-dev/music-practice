// Selecting a measure range by press-hold-drag on the score. The pure parts:
// when a press counts as a hold, which measure a point is over, and the span
// between two measures. The pointer wiring is in score_view.ts.

/** How long a press must stay put before it starts a selection. */
export const LONG_PRESS_MS = 500;
/** How far (px) a pointer may drift during that time and still count as held. */
export const HOLD_SLOP_PX = 8;

/** Whether a press at `start` is still a hold at (x, y),. */
export function stillHolding(
  start: { x: number; y: number },
  now: { x: number; y: number },
): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) <= HOLD_SLOP_PX;
}

/** Whether a held press has lasted long enough to start selecting. */
export function holdElapsed(elapsedMs: number): boolean {
  return elapsedMs >= LONG_PRESS_MS;
}

/** A measure's rectangle on the page, in px; `index` is the 0-based written measure. */
export interface MeasureBox {
  index: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * The measure under a point. Inside a box it is that box. Otherwise the
 * point is snapped: to the system (row of boxes) nearest vertically, then to
 * the box nearest horizontally in it, so a drag that strays into the margin
 * or between systems still selects something sensible. Null with no boxes.
 */
export function measureAt(boxes: readonly MeasureBox[], x: number, y: number): number | null {
  let best: MeasureBox | null = null;
  let bestDy = Infinity;
  let bestDx = Infinity;
  for (const b of boxes) {
    const dy = y < b.y0 ? b.y0 - y : y > b.y1 ? y - b.y1 : 0;
    const dx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0;
    if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
      best = b;
      bestDy = dy;
      bestDx = dx;
    }
  }
  return best ? best.index : null;
}

/** The span from one measure to another, whichever way it was dragged. */
export function spanBetween(a: number, b: number): { from: number; to: number } {
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/**
 * The 0-based measures to fade: those outside the practice range
 * `from`..`to` (1-based, inclusive) of `count` measures. None when the range
 * is the whole piece, so a whole piece shows no fading.
 */
export function outsideRange(count: number, from: number, to: number): number[] {
  if (from <= 1 && to >= count) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (i + 1 < from || i + 1 > to) out.push(i);
  return out;
}
