import { assertEquals } from "@std/assert";
import { effectiveTheme, toggled } from "./sheet_theme.ts";

Deno.test("the sheet follows the site until switched", () => {
  assertEquals(effectiveTheme("auto", true), "dark");
  assertEquals(effectiveTheme("auto", false), "light");
  assertEquals(effectiveTheme("light", true), "light");
});

Deno.test("switching flips the sheet; switching back follows the site again", () => {
  assertEquals(toggled("auto", true), "light"); // dark site, light sheet
  assertEquals(toggled("light", true), "auto");
  assertEquals(toggled("auto", false), "dark"); // light site, dark sheet
  assertEquals(toggled("dark", false), "auto");
});
