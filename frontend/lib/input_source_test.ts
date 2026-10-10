import { assertEquals } from "@std/assert";
import { forInput, inputOf, RunInput, validInput } from "./input_source.ts";
import { parseMessage } from "./midi.ts";

Deno.test("a run is midi only if every graded note was midi", () => {
  const r = new RunInput();
  assertEquals(r.value, "midi"); // nothing yet
  r.note({});
  r.note({ src: "midi" });
  assertEquals(r.value, "midi");
  r.note({ src: "screen" });
  r.note({ src: "midi" });
  assertEquals(r.value, "screen"); // any screen note makes it screen
  r.reset();
  assertEquals(r.value, "midi");
});

Deno.test("web MIDI events carry no src, so they read as midi", () => {
  const ev = parseMessage(new Uint8Array([0x90, 60, 80]), 0)!;
  assertEquals(ev.src, undefined);
  const r = new RunInput();
  r.note(ev);
  assertEquals(r.value, "midi");
});

Deno.test("a missing field reads as midi", () => {
  assertEquals(inputOf({}), "midi");
  assertEquals(inputOf({ input: "screen" }), "screen");
  assertEquals(forInput([{ id: 1 }, { id: 2, input: "screen" as const }], "midi"), [{ id: 1 }]);
  assertEquals(forInput([{ id: 1 }, { id: 2, input: "screen" as const }], "screen"), [
    { id: 2, input: "screen" },
  ]);
});

Deno.test("only the two values (or nothing) are valid", () => {
  for (const ok of [undefined, "midi", "screen"]) assertEquals(validInput(ok), true);
  for (const bad of ["", "MIDI", "keyboard", null, 1, {}, true]) {
    assertEquals(validInput(bad), false);
  }
});
