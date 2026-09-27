// Command music-practice serves the scale-practice site: Go page shells and
// the Deno-bundled TypeScript that reads a MIDI instrument and grades playing.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/17xande-dev/music-practice/internal/config"
	"github.com/17xande-dev/music-practice/internal/handler"
	"github.com/17xande-dev/music-practice/internal/middleware"
)

func main() {
	dev := flag.Bool("dev", false, "read templates and static files from the source tree on every request")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log, *dev); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger, dev bool) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}

	h, err := handler.New(handler.Options{Log: log, Dev: dev})
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr: cfg.Addr,
		Handler: middleware.Chain(h.Routes(),
			middleware.Logging(log),
			middleware.SecurityHeaders(middleware.Policy{HSTS: cfg.HSTS}),
		),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr, "dev", dev)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
