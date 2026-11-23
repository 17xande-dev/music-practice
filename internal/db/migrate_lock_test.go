package db

import (
	"database/sql"
	"io/fs"
	"path/filepath"
	"sync"
	"testing"
)

// openConcurrently calls OpenMigrated on one path from n goroutines released
// together and returns the databases that opened.
func openConcurrently(t *testing.T, path string, n int) []*sql.DB {
	return openConcurrentlyWith(t, path, n, migrationFiles())
}

// openConcurrentlyWith is openConcurrently over the given migrations.
func openConcurrentlyWith(t *testing.T, path string, n int, files fs.FS) []*sql.DB {
	t.Helper()
	var wg sync.WaitGroup
	start := make(chan struct{})
	dbs := make([]*sql.DB, n)
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() {
			<-start
			dbs[i], _, errs[i] = openMigrated(path, files)
		})
	}
	close(start)
	wg.Wait()
	var opened []*sql.DB
	for i := range n {
		if errs[i] != nil {
			t.Errorf("opener %d: %v", i, errs[i])
			continue
		}
		opened = append(opened, dbs[i])
		t.Cleanup(func() { dbs[i].Close() })
	}
	if len(opened) == 0 {
		t.Fatal("no opener succeeded")
	}
	return opened
}

// requireEachVersionOnce fails if goose recorded any version twice: what two
// processes applying the same migration, or adopting the same database, leave
// behind when nothing serialises them. Versions are 0 (goose's sentinel) and the migrations'.
func requireEachVersionOnce(t *testing.T, d *sql.DB) {
	t.Helper()
	requireVersionsOnce(t, d, 2)
}

func requireVersionsOnce(t *testing.T, d *sql.DB, want int) {
	t.Helper()
	var rows, distinct int
	if err := d.QueryRow(`SELECT count(*), count(DISTINCT version_id) FROM goose_db_version`).Scan(&rows, &distinct); err != nil {
		t.Fatal(err)
	}
	if rows != distinct || distinct != want {
		t.Fatalf("goose_db_version: %d rows, %d distinct versions, want %d each", rows, distinct, want)
	}
}

// Goose reads its pending list before it takes SQLite's write lock, so without
// the migration lock concurrent first opens (a restart overlapping its
// predecessor, a flag command beside the server) fail or apply a migration twice.
func TestConcurrentOpenMigratedOnAFreshDatabase(t *testing.T) {
	dbs := openConcurrently(t, filepath.Join(t.TempDir(), "fresh.db"), 8)
	requireEachVersionOnce(t, dbs[0])
}

// An old-runner database is adopted once; a second adopter would be refused
// (or double-adopt), and the rows must come through untouched.
func TestConcurrentOpenMigratedOnALegacyDatabase(t *testing.T) {
	d, path := open(t)
	legacyMigrate(t, d, files(t, nil))
	seedRows(t, d)
	d.Close()
	dbs := openConcurrently(t, path, 8)
	requireEachVersionOnce(t, dbs[0])
	for table, want := range map[string]int{"users": 1, "auth_sessions": 1, "records": 1} {
		if got := count(t, dbs[0], table); got != want {
			t.Errorf("%s has %d rows after adoption, want %d", table, got, want)
		}
	}
}

// The real schema has one migration, so two unlocked openers have little to
// collide on and can pass by luck. Several migrations, two of them an ALTER
// that fails when run twice, give a no-op lock many chances to be caught:
// without the lock an opener that read its pending list before another
// finished re-runs an ALTER and fails.
func TestConcurrentOpenMigratedOverSeveralMigrations(t *testing.T) {
	fsys := files(t, map[string]string{
		"0002_later.sql":   add0002,
		"0003_add_a.sql":   "-- +goose Up\nALTER TABLE later ADD COLUMN a TEXT NOT NULL DEFAULT '';\n",
		"0004_add_b.sql":   "-- +goose Up\nALTER TABLE later ADD COLUMN b TEXT NOT NULL DEFAULT '';\n",
		"0005_add_row.sql": "-- +goose Up\nCREATE TABLE more (id INTEGER PRIMARY KEY) STRICT;\n",
	})
	dbs := openConcurrentlyWith(t, filepath.Join(t.TempDir(), "fresh.db"), 8, fsys)
	requireVersionsOnce(t, dbs[0], 6) // 0..5
}
