package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/music-practice/internal/auth"
)

// Real argon2 costs ~100ms and 64 MiB per hash; these tests hash and
// verify hundreds of times and are about behaviour, not cost.
func TestMain(m *testing.M) {
	os.Exit(auth.RunWithFastHashes(m))
}

func TestInvalidBaseURLStopsBeforeMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	t.Setenv("DB_PATH", path)
	t.Setenv("BASE_URL", "https://example.com/path")
	t.Setenv("COOKIE_SECURE", "true")
	t.Setenv("ADDR", "invalid-address") // Never listen, even if validation regresses.
	err := run(slog.New(slog.NewTextHandler(io.Discard, nil)), false)
	if err == nil || !strings.Contains(err.Error(), "BASE_URL") {
		t.Errorf("startup returned %v, want a BASE_URL error", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("invalid config reached the database: stat error = %v", err)
	}
}

func TestInvalidSessionLifetimeStopsBeforeMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	t.Setenv("DB_PATH", path)
	t.Setenv("BASE_URL", "")
	t.Setenv("ADDR", "invalid-address") // Never listen, even if validation regresses.
	t.Setenv("DEVICE_SESSION_IDLE", "48h")
	t.Setenv("DEVICE_SESSION_ABSOLUTE", "24h")
	for _, attempt := range []struct {
		name string
		run  func() error
	}{
		{"serve", func() error { return run(slog.New(slog.NewTextHandler(io.Discard, nil)), false) }},
		{"account_command", func() error {
			return withStore(func(context.Context, *account.Store) error { return nil })
		}},
	} {
		t.Run(attempt.name, func(t *testing.T) {
			if err := attempt.run(); err == nil || !strings.Contains(err.Error(), "DEVICE_SESSION_ABSOLUTE") {
				t.Errorf("startup error = %v; want invalid device lifetime", err)
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("invalid config reached the database: stat error = %v", err)
			}
		})
	}
}
