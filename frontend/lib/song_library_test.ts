import { assert, assertEquals } from "@std/assert";
import {
  MAX_SONG_BYTES,
  songFormat,
  titleFromFileName,
  uploadProblem,
  validSongRecord,
} from "./song_library.ts";

const text = (s: string) => new TextEncoder().encode(s);
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "x">
<score-partwise version="4.0"><part-list/></score-partwise>`;

Deno.test("format comes from the bytes, not the name", () => {
  assertEquals(songFormat(text(XML)), "musicxml");
  assertEquals(songFormat(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), "mxl");
  assertEquals(songFormat(text("<html><body>hi</body></html>")), null);
  assertEquals(songFormat(text("MThd")), null); // a MIDI file
});

Deno.test("uploads are checked for emptiness, size and format", () => {
  assertEquals(uploadProblem("a.musicxml", new Uint8Array()), "a.musicxml is empty.");
  assert(uploadProblem("big.mxl", new Uint8Array(MAX_SONG_BYTES + 1))?.includes("too big"));
  assert(uploadProblem("song.mid", text("MThd\0\0\0\x06"))?.includes("isn't a MusicXML file"));
  assertEquals(uploadProblem("ok.xml", text(XML)), null);
});

Deno.test("titles from file names", () => {
  assertEquals(titleFromFileName("bach_minuet-in-g.mxl"), "bach minuet in g");
  assertEquals(titleFromFileName("Für Elise.musicxml"), "Für Elise");
  assertEquals(titleFromFileName(".xml"), "Untitled");
});

Deno.test("a library entry needs an id, file name and file data to be readable", () => {
  const ok = {
    id: "a",
    title: "T",
    composer: "",
    fileName: "a.musicxml",
    format: "musicxml",
    size: 3,
    added: 1,
    lastPractised: null,
    data: new ArrayBuffer(3),
  };
  assert(validSongRecord(ok));
  assert(!validSongRecord({ ...ok, data: undefined }));
  assert(!validSongRecord({ ...ok, data: new ArrayBuffer(0) }));
  assert(!validSongRecord({ ...ok, id: "" }));
  assert(!validSongRecord({ ...ok, id: 7 }));
  assert(!validSongRecord({ ...ok, fileName: undefined }));
  assert(!validSongRecord(null));
});
