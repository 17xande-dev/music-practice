package main

import (
	"context"
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/sqlitekit"
)

// backups is where and how the database is copied: a week of daily
// VACUUM INTO files named music-practice-YYYYMMDD.db, in a folder beside the
// database, so in the container they land on the same data volume. That
// guards against a bad migration or a mistaken delete, not against losing the
// volume: an off-box copy is a separate, still-open decision (README).
func backups(dbPath string) sqlitekit.Backups {
	return sqlitekit.Backups{
		Dir:    filepath.Join(filepath.Dir(dbPath), "backups"),
		Prefix: "music-practice-",
		Layout: "20060102",
		Keep:   7,
	}
}

// removeStalePartials deletes the music-practice-*.partial files that the
// backup code before sqlitekit left behind when it crashed mid-copy. The new
// code never makes that name, so nothing else would ever clean them up.
func removeStalePartials(log *slog.Logger, dir string) {
	matches, err := filepath.Glob(filepath.Join(dir, "music-practice-*.partial"))
	if err != nil {
		return
	}
	for _, m := range matches {
		if err := os.Remove(m); err != nil {
			log.Error("remove stale backup temp", "path", m, "err", err)
			continue
		}
		log.Info("removed stale backup temp", "path", m)
	}
}

// maintain runs the daily chores until ctx ends: back up the database (which
// also prunes old backups), and delete expired browser sessions. The first
// run is at startup, so a deploy always leaves a fresh backup of the state it
// started from.
func maintain(ctx context.Context, log *slog.Logger, database *sql.DB, accounts *account.Store, b sqlitekit.Backups) {
	removeStalePartials(log, b.Dir)
	tick := time.NewTicker(24 * time.Hour)
	defer tick.Stop()
	for {
		if path, made, err := b.Run(ctx, database, time.Now()); err != nil {
			log.Error("backup", "err", err)
		} else if made {
			log.Info("backup", "path", path)
		}
		if n, err := accounts.DeleteExpired(ctx); err != nil {
			log.Error("expire sessions", "err", err)
		} else if n > 0 {
			log.Info("expired sessions", "deleted", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
