import { assertEquals } from "@std/assert";
import {
  isStarterId,
  planStarterMigration,
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

const e = (id: string, fileName: string, added: number) => ({ id, fileName, added });

Deno.test("migration plan: rename the earliest copy, merge the rest, ignore other songs", () => {
  const plan = planStarterMigration([
    e("u2", "ode-to-joy.musicxml", 20),
    e("u1", "ode-to-joy.musicxml", 10),
    e("u3", "minuet-in-g.musicxml", 5),
    e("mine", "my-song.musicxml", 1),
  ]);
  assertEquals(
    Object.fromEntries(plan.remap),
    { u2: "starter:ode-to-joy", u1: "starter:ode-to-joy", u3: "starter:minuet-in-g" },
  );
  assertEquals(
    Object.fromEntries(plan.keep),
    { "starter:ode-to-joy": "u1", "starter:minuet-in-g": "u3" },
  );
});

Deno.test("migration plan: merges into an existing stable entry, and is idempotent", () => {
  const plan = planStarterMigration([
    e("starter:ode-to-joy", "ode-to-joy.musicxml", 30),
    e("u1", "ode-to-joy.musicxml", 10),
  ]);
  assertEquals([...plan.remap], [["u1", "starter:ode-to-joy"]]);
  assertEquals(plan.keep.size, 0);
  const done = planStarterMigration([e("starter:ode-to-joy", "ode-to-joy.musicxml", 30)]);
  assertEquals(done.remap.size, 0);
  assertEquals(done.keep.size, 0);
});
