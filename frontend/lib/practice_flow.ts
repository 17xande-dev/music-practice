// Pure decisions shared by the Scales and Songs pages: when a note starts a
// new run after one finished, and which keys to preview for the step after
// the current one.

/**
 * Whether an incoming note restarts the exercise: a note-on, once a run has
 * finished, in a mode where restarting needs nothing more (a wait mode;
 * Tempo needs its count-in, so it keeps an explicit restart). A note-off
 * never does.
 */
export function restartsOnNote(
  type: "on" | "off",
  finished: boolean,
  restartable: boolean,
): boolean {
  return type === "on" && finished && restartable;
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
