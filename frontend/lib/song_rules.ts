// Small decisions of the songs page that are worth testing apart from the
// DOM: what a tempo change does to a run, and when a tempo run is over.

export type SongMode = "learn" | "notes" | "tempo" | "rubato" | "listen";

/**
 * What changing the tempo % does, given the mode and the state of the run.
 * - "continue": nothing to redo (the mode doesn't use the tempo, or a
 *   finished run is left as it is).
 * - "replay": playing carries on from the current step at the new tempo.
 * - "restart": a fresh run from the current step (with a count-in if it was
 *   playing). The steps graded so far were at the old tempo, so they are
 *   dropped: a saved session has one tempo.
 */
export function tempoChange(
  mode: SongMode,
  run: { playing: boolean; finished: boolean },
): "continue" | "replay" | "restart" {
  if (mode === "listen") return run.playing ? "replay" : "continue";
  if (mode === "tempo" || mode === "rubato") return run.finished ? "continue" : "restart";
  return "continue"; // learn and notes wait for the player: no tempo
}

/**
 * A tempo run is over when its last timing window has closed *and* the audio
 * has played out (`endTime`: when the last note stops sounding), so a long
 * final note or a held chord is not cut off.
 */
export function tempoRunOver(windowsClosed: boolean, now: number, endTime: number): boolean {
  return windowsClosed && now >= endTime;
}

/**
 * Whether a run was finished: a tempo or listen run has phase "done"; a wait
 * mode (learn, notes, rubato) is finished when its engine is. A seek after a
 * finished run clears it and starts fresh, so two runs never merge.
 */
export function runFinished(phase: string, engineDone: boolean): boolean {
  return phase === "done" || engineDone;
}
