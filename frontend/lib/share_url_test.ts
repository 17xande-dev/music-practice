import { assertEquals } from "@std/assert";
import { fromQuery, parseTonic, type SharedSettings, tonicText, toQuery } from "./share_url.ts";

const piano: SharedSettings = {
  instrument: "piano",
  tonic: { letter: "F", acc: 1 },
  type: "harmonic-minor",
  hands: "both",
  octaves: 2,
  direction: "updown",
  mode: "tempo",
  bpm: 90,
  notesPerBeat: 2,
  position: 0,
  fingering: true,
};

Deno.test("a setup survives the round trip through a URL", () => {
  const q = toQuery(piano);
  assertEquals(
    q,
    "instrument=piano&key=F%23&scale=harmonic-minor&hands=both&octaves=2&dir=updown" +
      "&mode=tempo&bpm=90&beat=2&fingers=1",
  );
  const { position: _p, ...expected } = piano; // position is guitar-only
  assertEquals(fromQuery("?" + q), expected);
});

Deno.test("only the parameters that apply are written", () => {
  const guitar: SharedSettings = {
    ...piano,
    instrument: "guitar",
    position: 5,
    mode: "notes",
    fingering: false,
  };
  assertEquals(
    toQuery(guitar),
    "instrument=guitar&key=F%23&scale=harmonic-minor&position=5&octaves=2&dir=updown&mode=notes",
  );
});

Deno.test("note names in every common spelling", () => {
  assertEquals(parseTonic("Bb"), { letter: "B", acc: -1 });
  assertEquals(parseTonic("f♯"), { letter: "F", acc: 1 });
  assertEquals(parseTonic("Fx"), { letter: "F", acc: 2 });
  assertEquals(parseTonic("H"), null);
  assertEquals(tonicText({ letter: "E", acc: -1 }), "Eb");
});

Deno.test("invalid or hand-edited values are dropped, valid ones kept", () => {
  assertEquals(
    fromQuery("key=Q&scale=dubstep&octaves=9&bpm=5000&mode=tempo&hands=rh&fingers=yes"),
    { mode: "tempo", hands: "rh" },
  );
  assertEquals(fromQuery(""), {});
  assertEquals(fromQuery("fingers=0"), { fingering: false });
});
