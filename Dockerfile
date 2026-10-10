# Stage 1: bundle the frontend. The output lands in
# internal/handler/static/dist, which the Go build embeds.
FROM denoland/deno:alpine-2.9.7 AS frontend
WORKDIR /src
COPY deno.jsonc deno.lock ./
COPY frontend/ ./frontend/
RUN mkdir -p internal/handler/static/dist
# Populate the cache from the lockfile first, so a missing or wrong lock entry
# fails the build loudly instead of silently refetching something else.
RUN deno install --frozen --entrypoint frontend/practice.ts frontend/songs.ts frontend/progress.ts frontend/pitch_worklet.ts frontend/sw.ts frontend/theme.ts
RUN deno task bundle

# Stage 2: compile the server. go:embed reads static/dist at compile time, so
# the bundle must be copied in before `go build` runs.
#
# The SQLite driver (mattn/go-sqlite3) is cgo, so this stage needs a C
# compiler. Linking statically against musl keeps the binary self-contained,
# which is what lets the runtime stay distroless/static (no libc). The tags
# drop SQLite's extension loading (which static linking cannot support) and
# use Go's own DNS and user lookups instead of libc's.
FROM golang:1.27-alpine AS backend
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/internal/handler/static/dist ./internal/handler/static/dist
RUN CGO_ENABLED=1 go build -trimpath \
      -tags sqlite_omit_load_extension,osusergo,netgo \
      -ldflags='-s -w -linkmode external -extldflags "-static"' \
      -o /out/music-practice .
# The data volume's mount point, owned by distroless's nonroot user. Docker
# copies an image directory's ownership into a fresh named volume, so this is
# what makes the volume writable without running as root.
RUN mkdir -p /out/data

# Stage 3: the binary alone. Everything it serves is embedded, so the image
# needs no assets and no shell.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend /out/music-practice /music-practice
COPY --from=backend --chown=65532:65532 /out/data /data
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/music-practice"]
