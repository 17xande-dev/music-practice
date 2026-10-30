# The single entry point. Frontend steps call the deno.jsonc tasks, so each
# bundling command is written down once.

ADDR ?= :8080
# Local database. The container sets its own DB_PATH on the data volume.
DB_PATH ?= data/dev.db

# govulncheck is pinned here rather than in go.mod: it is a build-time tool.
# v1.1.x crashes on Go 1.27; v1.9.0 works.
GOVULNCHECK_VERSION ?= v1.9.0

.PHONY: build bundle run dev test test-go test-deno check fmt vet lint vulncheck-install vulncheck clean docker

## build: bundle the frontend, then compile the server that embeds it
build: bundle
	go build -o bin/music-practice .

## bundle: TypeScript -> internal/handler/static/dist (must precede go build/test)
bundle:
	deno task bundle

## run: build and run the embedded binary
run: build
	@mkdir -p $(dir $(DB_PATH))
	ADDR=$(ADDR) DB_PATH=$(DB_PATH) ./bin/music-practice

## dev: rebundle on change, and serve templates/assets from disk (-dev)
dev:
	deno task bundle
	@mkdir -p $(dir $(DB_PATH))
	deno task bundle-watch & trap 'kill $$!' EXIT; ADDR=$(ADDR) DB_PATH=$(DB_PATH) go run . -dev

## test: every test, Go and Deno
test: test-deno bundle test-go

test-go:
	go test -count=1 -race ./...

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
	go test -count=1 -race ./...
	$(MAKE) vulncheck-install vulncheck

fmt:
	gofmt -w .
	deno fmt

vet:
	go vet ./...

lint:
	deno lint

## vulncheck-install: install the pinned govulncheck
vulncheck-install:
	go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)

## vulncheck: fail if a reachable known vulnerability affects the build
vulncheck:
	govulncheck ./...

clean:
	deno task clean
	rm -rf bin

docker:
	docker build -t music-practice .
