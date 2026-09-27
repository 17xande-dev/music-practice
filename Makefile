# The single entry point. Frontend steps call the deno.jsonc tasks, so each
# bundling command is written down once.

ADDR ?= :8080

.PHONY: build bundle run dev test test-go test-deno check fmt vet lint clean docker

## build: bundle the frontend, then compile the server that embeds it
build: bundle
	go build -o bin/music-practice .

## bundle: TypeScript -> internal/handler/static/dist (must precede go build/test)
bundle:
	deno task bundle

## run: build and run the embedded binary
run: build
	ADDR=$(ADDR) ./bin/music-practice

## dev: rebundle on change, and serve templates/assets from disk (-dev)
dev:
	deno task bundle
	deno task bundle-watch & trap 'kill $$!' EXIT; ADDR=$(ADDR) go run . -dev

## test: every test, Go and Deno
test: test-deno bundle test-go

test-go:
	go test -count=1 ./...

test-deno:
	deno task test

## check: the gate before any commit — what CI runs
check:
	@test -z "$$(gofmt -l .)" || (echo "gofmt needed:"; gofmt -l .; exit 1)
	go vet ./...
	deno task check
	deno lint
	deno fmt --check
	deno task test
	deno task bundle
	go test -count=1 ./...

fmt:
	gofmt -w .
	deno fmt

vet:
	go vet ./...

lint:
	deno lint

clean:
	deno task clean
	rm -rf bin

docker:
	docker build -t music-practice .
