package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/music-practice/internal/dbtest"
)

// The config -> Backups wiring: where backups go and what they are called is
// what an operator's restore recipe depends on.
func TestBackupsSettings(t *testing.T) {
	b := backups("/data/music-practice.db")
	if b.Dir != "/data/backups" || b.Prefix != "music-practice-" || b.Layout != "20060102" || b.Keep != 7 || b.Location != nil {
		t.Errorf("backups = %+v", b)
	}
}

// Startup must back up the database, clear the crash temps, and sweep expired
// sessions even if their owners never use the credentials again.
func TestMaintainBacksUpAtStartupAndClearsPartials(t *testing.T) {
	d := dbtest.New(t)
	accounts := account.NewStore(d, account.DefaultLifetimes())
	u, err := accounts.Create(t.Context(), "u@example.com", "unused hash", false)
	if err != nil {
		t.Fatal(err)
	}
	_, old, err := accounts.SignIn(t.Context(), u, account.KindDevice, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.ExecContext(t.Context(), `UPDATE auth_sessions
		SET created_at = '2000-01-01T00:00:00Z', expires_at = '' WHERE id = ?`, old.ID); err != nil {
		t.Fatal(err)
	}
	b := backups(filepath.Join(t.TempDir(), "music-practice.db"))
	if err := os.MkdirAll(b.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	partial := filepath.Join(b.Dir, "music-practice-20261001.db.partial")
	foreign := filepath.Join(b.Dir, "notes.partial")
	for _, p := range []string{partial, foreign} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	ctx, stop := context.WithCancel(t.Context())
	done := make(chan struct{})
	t.Cleanup(func() {
		stop()
		<-done
	})
	go func() {
		defer close(done)
		maintain(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), d, accounts, b)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		files, err := b.List()
		if err != nil {
			t.Fatal(err)
		}
		var remaining int
		if err := d.QueryRowContext(t.Context(), `SELECT count(*) FROM auth_sessions`).Scan(&remaining); err != nil {
			t.Fatal(err)
		}
		if len(files) == 1 && remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("maintain did not back up and sweep expired device sessions: backups=%d sessions=%d", len(files), remaining)
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	<-done

	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Error("the old .partial temp was not removed")
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Error("a file that is not a music-practice partial was removed")
	}
}
