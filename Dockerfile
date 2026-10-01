# Stage 1: bundle the frontend. The output lands in
# internal/handler/static/dist, which the Go build embeds.
FROM denoland/deno:alpine-2.9.7 AS frontend
WORKDIR /src
COPY deno.jsonc deno.lock ./
COPY frontend/ ./frontend/
RUN mkdir -p internal/handler/static/dist
# Populate the cache from the lockfile first, so a missing or wrong lock entry
# fails the build loudly instead of silently refetching something else.
RUN deno install --frozen --entrypoint frontend/practice.ts frontend/songs.ts frontend/progress.ts frontend/pitch_worklet.ts frontend/sw.ts
RUN deno task bundle

# Stage 2: compile the server. go:embed reads static/dist at compile time, so
# the bundle must be copied in before `go build` runs.
FROM golang:1.27-alpine AS backend
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
COPY --from=frontend /src/internal/handler/static/dist ./internal/handler/static/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/music-practice .

# Stage 3: the binary alone. Everything it serves is embedded, so the image
# needs no assets and no shell.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend /out/music-practice /music-practice
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/music-practice"]
