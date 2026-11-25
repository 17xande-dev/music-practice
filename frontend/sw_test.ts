import { assert, assertEquals } from "@std/assert";

Deno.test("the offline worker stores only public shells and static assets", async () => {
  const origin = "https://practice.example";
  const writes: string[] = [];
  const jobs = new Map<string, (event: unknown) => void>();
  const cache = {
    put(key: string | Request, _res: Response) {
      writes.push(typeof key === "string" ? key : key.url);
      return Promise.resolve();
    },
    add(key: string) {
      writes.push(key);
      return Promise.resolve();
    },
    match(_key: string) {
      return Promise.resolve(undefined);
    },
  };
  const stubs = {
    self: {
      location: { origin },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        jobs.set(type, listener),
      skipWaiting: () => Promise.resolve(),
    },
    caches: { open: () => Promise.resolve(cache) },
    fetch: (request: string | Request) => {
      const path = typeof request === "string" ? request : new URL(request.url).pathname;
      const privatePage = path.startsWith("/account") || path.startsWith("/admin");
      return Promise.resolve(
        new Response(privatePage ? "account details" : "public shell", {
          headers: { "Cache-Control": privatePage ? "no-store" : "no-cache" },
        }),
      );
    },
  };
  const originals = new Map(
    Object.keys(stubs).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)!]),
  );
  try {
    for (const [key, value] of Object.entries(stubs)) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    await import("./sw.ts");
    let install: Promise<void> | undefined;
    jobs.get("install")!({ waitUntil: (job: Promise<void>) => install = job });
    assert(install);
    await install;
    assertEquals(writes.slice().sort(), [
      "/",
      "/about",
      "/progress",
      "/songs",
      "/static/icon-192.png",
      "/static/icon-512.png",
      "/static/manifest.webmanifest",
    ]);
    writes.length = 0;

    const request = (
      path: string,
      method: string,
      mode: RequestMode,
    ): Promise<Response> | undefined => {
      let result: Promise<Response> | undefined;
      jobs.get("fetch")!({
        request: { url: `${origin}${path}`, method, mode },
        respondWith: (response: Promise<Response>) => result = response,
      });
      return result;
    };
    for (const path of ["/account", "/admin/users"]) {
      const response = await request(path, "GET", "navigate");
      assertEquals(response?.headers.get("Cache-Control"), "no-store");
    }
    assertEquals(request("/api/me", "GET", "same-origin"), undefined);
    assertEquals(request("/api/sync", "POST", "same-origin"), undefined);
    assertEquals(request("/account/logout", "POST", "navigate"), undefined);
    assertEquals(request("/", "POST", "navigate"), undefined);
    assertEquals(writes, []);

    assertEquals(
      await (await request("/songs?selected=1", "GET", "navigate"))?.text(),
      "public shell",
    );
    assertEquals(writes, ["/songs"]);
  } finally {
    for (const [key, descriptor] of originals) {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
});
