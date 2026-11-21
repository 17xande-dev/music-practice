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

// The loop must actually take a backup at startup, and clear the old
// crash temps first; a loop that silently stopped calling Run would leave the
// app with no backups and no error.
func TestMaintainBacksUpAtStartupAndClearsPartials(t *testing.T) {
	d := dbtest.New(t)
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
	go func() {
		defer close(done)
		maintain(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), d, account.NewStore(d), b)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		files, err := b.List()
		if err != nil {
			t.Fatal(err)
		}
		if len(files) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("maintain made no backup at startup")
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
