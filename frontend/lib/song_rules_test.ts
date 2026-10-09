import { assert, assertEquals } from "@std/assert";
import { runFinished, tempoChange, tempoRunOver } from "./song_rules.ts";

const playing = { playing: true, finished: false };
const paused = { playing: false, finished: false };
const done = { playing: false, finished: true };

Deno.test("tempo change: listen carries on from the current step, the wait modes are unaffected", () => {
  assertEquals(tempoChange("listen", playing), "replay");
  assertEquals(tempoChange("listen", paused), "continue");
  assertEquals(tempoChange("notes", playing), "continue");
  assertEquals(tempoChange("learn", paused), "continue");
});

Deno.test("tempo change: tempo and rubato start a fresh run so a session has one tempo", () => {
  for (const m of ["tempo", "rubato"] as const) {
    assertEquals(tempoChange(m, playing), "restart");
    assertEquals(tempoChange(m, paused), "restart");
    assertEquals(tempoChange(m, done), "continue"); // the results stand
  }
});

Deno.test("a tempo run ends after the last window closes and the audio has played out", () => {
  assert(!tempoRunOver(false, 5000, 4000)); // windows still open
  assert(!tempoRunOver(true, 3000, 4000)); // last window closed, final chord still sounding
  assert(tempoRunOver(true, 4000, 4000));
  assert(tempoRunOver(true, 4500, 4000));
});

Deno.test("a run is finished when its phase is done or its engine is", () => {
  assert(runFinished("done", false));
  assert(runFinished("idle", true));
  assert(!runFinished("playing", false));
  assert(!runFinished("idle", false));
});
