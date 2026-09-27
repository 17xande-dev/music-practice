# Music Practice

A site for practising scales on a MIDI instrument such as a digital piano. You connect the instrument in the browser (Web MIDI), pick a scale, and play it. The page shows your playing live on a keyboard and a staff, and grades it.

Stage 1 has no accounts. Practice history is kept in your browser's localStorage.

## Develop

```sh
make dev     # rebundle TypeScript on change + run the server with -dev on :8080
make check   # the full gate: gofmt, vet, deno check/lint/fmt/test, bundle, go test
make build   # bundle, then compile bin/music-practice with everything embedded
```

The tools are Go 1.27 and Deno 2.9, pinned in `mise.toml`.

The layout is described in the README's architecture section (written in phase 7).
