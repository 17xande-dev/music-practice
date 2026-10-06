import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { type Click, FollowingClick } from "./guide_click.ts";

/** Take clicks up to time `until`, as the page's scheduler would. */
function clicksUntil(f: FollowingClick, until: number): Click[] {
  const out: Click[] = [];
  for (let c = f.next(); c && c.t <= until; c = f.next()) {
    out.push(c);
    f.take(c.beat);
  }
  return out;
}

Deno.test("before the player starts, it clicks at the starting tempo, then waits", () => {
  const f = new FollowingClick(500, { beat: 0, t: 1000 }, {}, 4);
  const c = clicksUntil(f, 10_000);
  assertEquals(c.map((x) => [x.beat, x.t]), [[0, 1000], [1, 1500], [2, 2000], [3, 2500], [
    4,
    3000,
  ]]);
  assertEquals(f.next(), null);
});

Deno.test("clicks land on the player's beats, measured from their last note", () => {
  const f = new FollowingClick(500, { beat: 0, t: 0 });
  // Quarter notes at a steady 600 ms: the click settles onto 600.
  for (let b = 0; b < 12; b++) f.onNote(b, b * 600, b >= 2 ? 600 : null, b + 1);
  assertAlmostEquals(f.beatMs, 600, 2);
  const c = clicksUntil(f, 11 * 600 + 700);
  assertEquals(c.at(-1)!.beat, 12);
  assertAlmostEquals(c.at(-1)!.t, 11 * 600 + f.beatMs, 1e-9);
});

Deno.test("one late note moves the tempo only part of the way", () => {
  const f = new FollowingClick(500, { beat: 0, t: 0 });
  f.onNote(4, 2000, 500, 5);
  f.onNote(5, 2900, 900, 6); // estimate jumps to 900 ms
  assertAlmostEquals(f.beatMs, 500 + 0.35 * 400, 1e-9); // 640, not 900
});

Deno.test("if the player stops, the click waits, then picks up from their next note", () => {
  const f = new FollowingClick(500, { beat: 0, t: 0 });
  f.onNote(0, 0, null, 2); // a half note: the next note is due on beat 2
  // Clicks run to beat 2 plus two beats of grace, then stop.
  assertEquals(clicksUntil(f, 60_000).map((x) => x.beat), [0, 1, 2, 3, 4]);
  assertEquals(f.next(), null);
  // The player comes back on beat 2, 10 s later: clicks resume from there.
  f.onNote(2, 10_000, null, 3);
  const next = f.next()!;
  assertEquals(next.beat, 5); // beats already passed aren't repeated
  assert(next.t > 10_000);
});
