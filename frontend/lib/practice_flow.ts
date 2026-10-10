// Pure decisions shared by the Scales and Songs pages: when a note starts a
// new run after one finished, and which keys to preview for the step after
// the current one.

/** Silence after a finished run before a note starts the next one (ms). */
export const RESTART_GAP_MS = 1000;

/**
 * Whether an incoming note restarts the exercise: a note-on, once a run has
 * finished, after at least RESTART_GAP_MS of silence since the previous
 * note-on (`lastOnT`, the finishing note or any later one; event
 * timestamps). A straggler or carried-on playing inside that window does
 * not restart (the caller ignores it and moves `lastOnT` on). A note-off
 * never does.
 */
export function restartsOnNote(
  type: "on" | "off",
  finished: boolean,
  t: number,
  lastOnT: number,
): boolean {
  return type === "on" && finished && t - lastOnT >= RESTART_GAP_MS;
}

/**
 * The keys to preview after step `i`: the whole next step in play order
 * (`steps` is already unrolled for repeats, one-pass ranges and the practised
 * hands), minus any key that is also a current target. Empty at the end.
 */
export function nextKeys(
  steps: readonly { notes: readonly { midi: number }[] }[],
  i: number,
): number[] {
  const next = steps[i + 1];
  if (i < 0 || !next) return [];
  const now = new Set(steps[i].notes.map((n) => n.midi));
  return next.notes.map((n) => n.midi).filter((m) => !now.has(m));
}
