import { assertEquals } from "@std/assert";
import {
  isStarterId,
  staleStarterIds,
  starterId,
  STARTERS,
  starterSlugForFile,
  starterSlugForTitle,
} from "./starters.ts";

Deno.test("starter ids are starter:<slug>, matching the files served", async () => {
  assertEquals(starterId("ode-to-joy"), "starter:ode-to-joy");
  const files = [...Deno.readDirSync("internal/handler/static/songs")]
    .map((e) => e.name.replace(/\.musicxml$/, "")).sort();
  assertEquals(STARTERS.map((s) => s.slug).sort(), files);
  for (const f of files) assertEquals(starterSlugForFile(`${f}.musicxml`), f);
  assertEquals(starterSlugForFile("my-song.musicxml"), null);
  assertEquals(isStarterId("starter:minuet-in-g"), true);
  assertEquals(isStarterId(crypto.randomUUID()), false);
  // Ids stay within the 64 characters the session validators allow.
  for (const s of STARTERS) assertEquals(starterId(s.slug).length <= 64, true);
  // Titles in the files themselves are recognised.
  for (const s of STARTERS) {
    const xml = await Deno.readTextFile(`internal/handler/static/songs/${s.slug}.musicxml`);
    const title = /<work-title>([^<]*)/.exec(xml)![1];
    assertEquals(starterSlugForTitle(title), s.slug);
  }
  assertEquals(starterSlugForTitle("Something else"), null);
});

Deno.test("stale starter copies (starter file, non-starter id) are the ones to delete", () => {
  assertEquals(
    staleStarterIds([
      { id: "u1", fileName: "ode-to-joy.musicxml" },
      { id: "starter:ode-to-joy", fileName: "ode-to-joy.musicxml" },
      { id: "mine", fileName: "my-song.musicxml" },
    ]),
    ["u1"],
  );
});
