package db_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/17xande-dev/music-practice/internal/db"
	"github.com/17xande-dev/music-practice/internal/dbtest"
	"github.com/17xande-dev/sqlitekit"
)

// Checked against sqlite_master rather than the .sql files, because
// CREATE TABLE ... STRICT on an existing table reports success and changes
// nothing — the file can say STRICT while the database is not.
func TestEveryTableIsStrict(t *testing.T) {
	d := dbtest.New(t)
	rows, err := d.Query(`SELECT name, sql FROM sqlite_master
	                      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var name, ddl string
		if err := rows.Scan(&name, &ddl); err != nil {
			t.Fatal(err)
		}
		n++
		if !strings.Contains(strings.ToUpper(ddl), ") STRICT") {
			t.Errorf("table %s is not STRICT", name)
		}
	}
	// Without a floor this passes vacuously the day the schema stops applying.
	if n < 3 {
		t.Fatalf("found %d tables, want at least 3", n)
	}
}

// A redeploy opens an up-to-date database every time.
func TestMigrateTwiceIsANoOp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "twice.db")
	first, applied, err := db.OpenMigrated(path)
	if err != nil || len(applied) != 1 {
		t.Fatalf("first open: applied %v, err %v", applied, err)
	}
	first.Close()
	d, applied, err := db.OpenMigrated(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if len(applied) != 0 {
		t.Errorf("second run applied %v", applied)
	}
}

// Without foreign_keys on every REFERENCES is decoration: deleting a user
// would leave their sessions able to sign in as nobody.
func TestForeignKeysEnforced(t *testing.T) {
	d := dbtest.New(t)
	_, err := d.Exec(`INSERT INTO auth_sessions (token_hash, user_id, kind, created_at, last_used_at)
	                  VALUES ('x', 999, 'web', '', '')`)
	if err == nil {
		t.Fatal("session for a missing user was accepted")
	}
}

func TestStrictRefusesWrongType(t *testing.T) {
	d := dbtest.New(t)
	_, err := d.Exec(`INSERT INTO users (email, password_hash, is_admin, created_at)
	                  VALUES ('a@b.c', 'h', 'yes', '')`)
	if err == nil {
		t.Fatal("STRICT accepted a string in an INTEGER column")
	}
}

// A transaction holds the write lock from the moment it begins, so a read
// followed by a write inside it cannot be invalidated by another connection's
// commit in between ("database is locked", which busy_timeout cannot cure).
func TestTransactionsBeginImmediate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	d, _, err := db.OpenMigrated(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	tx, err := d.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// A second handle with no wait: it can only write if tx holds no lock yet.
	other, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	_, err = other.Exec(`INSERT INTO users (email, password_hash, created_at) VALUES ('a@x.com', 'h', '')`)
	if err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("a write succeeded while a transaction was open (err = %v); transactions must begin immediate", err)
	}
}

// Open must refuse a database whose settings did not take, and accept one
// that has them: foreign keys on, WAL, a busy timeout. Check is what turns
// a silently ignored DSN parameter into a startup failure.
func TestOpenAppliesTheStandardSettings(t *testing.T) {
	d := dbtest.New(t)
	var fk int
	var mode string
	var busy int
	if err := d.QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
		t.Errorf("foreign_keys = %d, err %v", fk, err)
	}
	if err := d.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Errorf("journal_mode = %q, err %v", mode, err)
	}
	if err := d.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil || busy != 5000 {
		t.Errorf("busy_timeout = %d, err %v", busy, err)
	}
}

func TestOpenFailsOnAnUnusablePath(t *testing.T) {
	if _, err := db.Open(filepath.Join(t.TempDir(), "missing-dir", "x.db")); err == nil {
		t.Fatal("opened a database in a directory that does not exist")
	}
}

// Open must stop startup when the settings check fails. Swapping Check for a
// plain ping would still open a healthy database, so only a failing check
// shows that Open really consults it.
func TestOpenFailsWhenTheSettingsCheckFails(t *testing.T) {
	want := errors.New("settings did not take")
	db.SetCheckForTest(t, func(context.Context, *sql.DB, sqlitekit.Options) error { return want })
	if _, err := db.Open(filepath.Join(t.TempDir(), "x.db")); !errors.Is(err, want) {
		t.Fatalf("Open err = %v, want the check's error", err)
	}
}
