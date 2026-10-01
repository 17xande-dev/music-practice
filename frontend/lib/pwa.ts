// Registers the service worker (frontend/sw.ts, served at /sw.js so its
// scope is the whole site). Every page bundle imports this; failure is
// harmless, the site just doesn't work offline.

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return;
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
