import { assertEquals } from "@std/assert";
import { assetUrls } from "./sw_assets.ts";

Deno.test("the worker finds every asset a page references", () => {
  const html = `<link rel="stylesheet" href="/static/styles.css?v=abc">
<script type="module" src="/static/dist/practice.js?v=123"></script>
<div data-worklet="/static/dist/pitch_worklet.js?v=9"></div>
<button data-src='/static/songs/ode-to-joy.musicxml?v=7'></button>
<a href="/progress">Progress</a> <img src="/static/icon.svg?v=1">
<link rel="stylesheet" href="/static/styles.css?v=abc">`;
  assertEquals(assetUrls(html), [
    "/static/styles.css?v=abc",
    "/static/dist/practice.js?v=123",
    "/static/dist/pitch_worklet.js?v=9",
    "/static/songs/ode-to-joy.musicxml?v=7",
    "/static/icon.svg?v=1",
  ]);
});
