import { assertEquals } from "@std/assert";
import { parseMessage } from "./midi.ts";
import { pcForCode, resolveOctave } from "./qwerty.ts";

Deno.test("MIDI note-on, note-off, and velocity-0 note-on", () => {
  assertEquals(parseMessage(new Uint8Array([0x90, 60, 100]), 5), {
    type: "on",
    midi: 60,
    velocity: 100,
    t: 5,
  });
  assertEquals(parseMessage(new Uint8Array([0x80, 60, 40]), 6), {
    type: "off",
    midi: 60,
    velocity: 0,
    t: 6,
  });
  // Most keyboards send this for key-up rather than 0x80.
  assertEquals(parseMessage(new Uint8Array([0x90, 60, 0]), 7), {
    type: "off",
    midi: 60,
    velocity: 0,
    t: 7,
  });
});

Deno.test("MIDI: any channel is read; other messages are ignored", () => {
  assertEquals(parseMessage(new Uint8Array([0x9f, 21, 1]), 0)?.type, "on"); // channel 16
  assertEquals(parseMessage(new Uint8Array([0xb0, 64, 127]), 0), null); // sustain pedal
  assertEquals(parseMessage(new Uint8Array([0xfe]), 0), null); // active sensing
  assertEquals(parseMessage(new Uint8Array([0xe0, 0, 64]), 0), null); // pitch bend
});

Deno.test("QWERTY maps the A row to pitch classes", () => {
  assertEquals(pcForCode("KeyA"), 0);
  assertEquals(pcForCode("KeyW"), 1);
  assertEquals(pcForCode("KeyJ"), 11);
  assertEquals(pcForCode("KeyK"), 0);
  assertEquals(pcForCode("KeyZ"), undefined);
});

Deno.test("QWERTY presses sound in the octave nearest each target", () => {
  assertEquals(resolveOctave(2, [62]), [62]); // D wanted, D pressed
  assertEquals(resolveOctave(2, [86, 74]), [86, 74]); // both hands
  assertEquals(resolveOctave(1, [62]), [61]); // a wrong note lands next to the target
  assertEquals(resolveOctave(11, [60]), [59]); // B below C, not an octave up
  assertEquals(resolveOctave(6, [60]), [54]); // tritone: ties resolve downward
  assertEquals(resolveOctave(7, []), [55]); // idle: around middle C
});
