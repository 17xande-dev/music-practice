package db

import (
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
)

// openConcurrently calls OpenMigrated on one path from n goroutines released
// together and returns the databases that opened.
func openConcurrently(t *testing.T, path string, n int) []*sql.DB {
	t.Helper()
	var wg sync.WaitGroup
	start := make(chan struct{})
	dbs := make([]*sql.DB, n)
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() {
			<-start
			dbs[i], _, errs[i] = OpenMigrated(path)
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
// behind when nothing serialises them. Versions are 0 (goose's sentinel) and 1.
func requireEachVersionOnce(t *testing.T, d *sql.DB) {
	t.Helper()
	var rows, distinct int
	if err := d.QueryRow(`SELECT count(*), count(DISTINCT version_id) FROM goose_db_version`).Scan(&rows, &distinct); err != nil {
		t.Fatal(err)
	}
	if rows != distinct || distinct != 2 {
		t.Fatalf("goose_db_version: %d rows, %d distinct versions, want 2 each", rows, distinct)
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
