package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// files is the real 0001 plus any extra migrations a test wants to apply on
// top, so "a later migration still applies" is tested without inventing a
// schema change the app does not have.
func files(t *testing.T, extra map[string]string) fs.FS {
	t.Helper()
	b, err := migrationsFS.ReadFile("migrations/0001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	m := fstest.MapFS{"0001_init.sql": {Data: b}}
	for name, sql := range extra {
		m[name] = &fstest.MapFile{Data: []byte(sql)}
	}
	return m
}

const add0002 = "-- +goose Up\nCREATE TABLE later (id INTEGER PRIMARY KEY, note TEXT NOT NULL DEFAULT '') STRICT;\n"

func open(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.db")
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d, path
}

// legacyMigrate is the runner this package had before goose, copied as it
// was: each migration's SQL and its PRAGMA user_version bump in one
// transaction. A database built with it is what production holds today.
func legacyMigrate(t *testing.T, d *sql.DB, fsys fs.FS) {
	t.Helper()
	names, err := fs.Glob(fsys, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i, n := range names {
		b, err := fs.ReadFile(fsys, n)
		if err != nil {
			t.Fatal(err)
		}
		tx, err := d.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(string(b)); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
}

func seedRows(t *testing.T, d *sql.DB) {
	t.Helper()
	for _, q := range []string{
		`INSERT INTO users (email, password_hash, created_at) VALUES ('a@x.com', 'h', '2026-01-01T00:00:00Z')`,
		`INSERT INTO auth_sessions (token_hash, user_id, kind, created_at, last_used_at) VALUES ('t', 1, 'web', '', '')`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'scale', 'r1', '{}')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
}

func count(t *testing.T, d *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := d.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A database written by the old runner (tables, user_version, no goose table)
// is adopted with its rows intact and goose then applies only what is newer.
// Without Adopt, goosestrict refuses it (tables but no history), which is the
// proof that the adoption is what lets production boot.
func TestAdoptsADatabaseFromTheOldRunner(t *testing.T) {
	d, _ := open(t)
	legacyMigrate(t, d, files(t, nil))
	seedRows(t, d)

	ctx := context.Background()
	fsys := files(t, map[string]string{"0002_later.sql": add0002})
	applied, err := migrate(ctx, d, fsys)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0] != "0002_later.sql" {
		t.Fatalf("applied %v, want only 0002_later.sql (0001 was the old runner's)", applied)
	}
	for table, want := range map[string]int{"users": 1, "auth_sessions": 1, "records": 1} {
		if got := count(t, d, table); got != want {
			t.Errorf("%s has %d rows after adoption, want %d", table, got, want)
		}
	}
	lines, err := status(ctx, d, fsys)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "applied") || !strings.HasPrefix(lines[1], "applied") {
		t.Errorf("status = %q, want 1..2 applied", lines)
	}
	// Adopting is once only: the next start finds the goose table and runs Up.
	if applied, err := migrate(ctx, d, fsys); err != nil || len(applied) != 0 {
		t.Errorf("second start applied %v, err %v", applied, err)
	}
}

// -migrate-status on a database not yet adopted reports it from user_version
// and leaves it unadopted: it is a read-only command.
func TestStatusDoesNotAdopt(t *testing.T) {
	d, _ := open(t)
	legacyMigrate(t, d, files(t, nil))
	lines, err := status(context.Background(), d, files(t, map[string]string{"0002_later.sql": add0002}))
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "applied") || !strings.HasPrefix(lines[1], "pending") {
		t.Errorf("status = %q", lines)
	}
	var n int
	if err := d.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'goose_db_version'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("status created the version table (n=%d, err %v)", n, err)
	}
}

func TestFreshDatabaseMigratesFromZero(t *testing.T) {
	d, _ := open(t)
	applied, err := migrate(context.Background(), d, files(t, map[string]string{"0002_later.sql": add0002}))
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 2 || applied[0] != "0001_init.sql" || applied[1] != "0002_later.sql" {
		t.Fatalf("applied %v", applied)
	}
	if got := count(t, d, "goose_db_version"); got != 3 { // version 0, 1, 2
		t.Errorf("version table has %d rows, want 3", got)
	}
}

// Running an older binary against a newer schema is how data is damaged.
func TestRefusesADatabaseNewerThanTheBinary(t *testing.T) {
	ctx := context.Background()
	t.Run("goose database", func(t *testing.T) {
		d, _ := open(t)
		if _, err := migrate(ctx, d, files(t, map[string]string{"0002_later.sql": add0002})); err != nil {
			t.Fatal(err)
		}
		if _, err := migrate(ctx, d, files(t, nil)); err == nil {
			t.Fatal("an older build migrated a newer database")
		}
	})
	t.Run("old runner database", func(t *testing.T) {
		d, _ := open(t)
		legacyMigrate(t, d, files(t, nil))
		if _, err := d.Exec("PRAGMA user_version = 999"); err != nil {
			t.Fatal(err)
		}
		if _, err := migrate(ctx, d, files(t, nil)); err == nil {
			t.Fatal("adopted a database newer than the binary")
		}
		var n int
		if err := d.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'goose_db_version'`).Scan(&n); err != nil || n != 0 {
			t.Errorf("refusal still wrote the version table (n=%d, err %v)", n, err)
		}
	})
}

// Tables with no user_version and no goose table have no history to trust.
func TestRefusesTablesWithNoHistory(t *testing.T) {
	d, _ := open(t)
	if _, err := d.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY) STRICT`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate(context.Background(), d, files(t, nil)); err == nil {
		t.Fatal("adopted a database with tables and user_version 0")
	}
}
