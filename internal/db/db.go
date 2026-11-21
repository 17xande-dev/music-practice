// Package db opens the SQLite database and brings its schema up to date.
//
// One file holds every user: the login lookup needs a shared table anyway,
// and the server runs as a single instance. The trigger that would change
// this is running a second instance (see the README's open decisions).
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"github.com/17xande-dev/sqlitekit"
	"github.com/17xande-dev/sqlitekit/goosestrict"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// checkSettings is a variable so a test can prove Open refuses to start when
// the check fails: replacing it with a bare ping would otherwise go unnoticed.
var checkSettings = sqlitekit.Check

// Open opens (creating if absent) the database at path with sqlitekit's
// settings (foreign keys, WAL, busy timeout, immediate transactions) and
// refuses to start if the driver did not apply them. WAL makes a plain `cp`
// of the file an unsafe backup, so backups use VACUUM INTO.
//
// Schema changes go through a numbered migration, never an ALTER run on
// startup: on a STRICT table that leaves the database diverged from the
// schema files.
func Open(path string) (*sql.DB, error) {
	opts := sqlitekit.Options{}
	dsn, err := sqlitekit.DSN(path, opts)
	if err != nil {
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	// Check connects, so a bad path or an unwritable directory fails at
	// startup rather than on the first sign-in, and a setting the driver
	// silently ignored fails here rather than months later.
	if err := checkSettings(context.Background(), d, opts); err != nil {
		d.Close()
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	return d, nil
}

// Migrate brings the schema up to date and returns the migrations it applied.
//
// Migrations are goose files (-- +goose Up) run through goosestrict, whose
// version table is STRICT like every other table here. A database written by
// the previous runner has no version table and records its progress in
// PRAGMA user_version; it is adopted once, below.
func Migrate(d *sql.DB) (applied []string, err error) {
	return migrate(context.Background(), d, migrationFiles())
}

// migrationFiles is the embedded migrations directory as the root of an
// fs.FS, which is what goose reads.
func migrationFiles() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err) // a constant, embedded path
	}
	return sub
}

func migrate(ctx context.Context, d *sql.DB, files fs.FS) ([]string, error) {
	if legacy, err := legacyVersion(ctx, d, files); err != nil {
		return nil, err
	} else if legacy > 0 {
		// The previous runner applied migrations 1..user_version in order,
		// each with its version bump in one transaction, so those are exactly
		// the ones goose may skip. Adopting at the wrong version silently skips
		// real migrations, which is why anything doubtful is refused instead.
		if err := goosestrict.Adopt(ctx, d, legacy); err != nil {
			return nil, fmt.Errorf("db: adopt a database at version %d: %w", legacy, err)
		}
	}
	p, err := goosestrict.NewProvider(d, files)
	if err != nil {
		return nil, fmt.Errorf("db: %w", err)
	}
	results, err := p.Up(ctx)
	var applied []string
	for _, r := range results {
		if r.Error == nil {
			applied = append(applied, r.Source.Path)
		}
	}
	if err != nil {
		return applied, fmt.Errorf("db: %w", err)
	}
	return applied, nil
}

// legacyVersion returns the PRAGMA user_version of a database that holds
// tables but no goose version table, i.e. one written by the previous
// migration runner, and 0 for any other database. It refuses a legacy database
// the binary cannot vouch for: user_version 0 with tables (no record of what
// ran) and a version newer than the migrations this build embeds (a rollback
// deploy).
func legacyVersion(ctx context.Context, d *sql.DB, files fs.FS) (int64, error) {
	var hasVersionTable, tables int
	if err := d.QueryRowContext(ctx, `SELECT
	    count(*) FILTER (WHERE name = ?),
	    count(*) FILTER (WHERE name NOT LIKE 'sqlite_%')
	    FROM sqlite_master WHERE type = 'table'`, goose.DefaultTablename).Scan(&hasVersionTable, &tables); err != nil {
		return 0, err
	}
	if hasVersionTable > 0 || tables == 0 {
		return 0, nil
	}
	var v int64
	if err := d.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil {
		return 0, err
	}
	if v == 0 {
		return 0, errors.New("db: the database has tables but neither a goose version table nor a PRAGMA user_version: its migration history is unknown, so it is not adopted")
	}
	known, err := fs.Glob(files, "*.sql")
	if err != nil {
		return 0, err
	}
	if v > int64(len(known)) {
		return 0, fmt.Errorf("db: database is at version %d but this build knows only %d: refusing to run an older binary against it", v, len(known))
	}
	return v, nil
}

// Status describes each known migration as applied or pending, for the
// -migrate-status flag. It never writes to a database it has to adopt: a
// legacy database is reported from its user_version.
func Status(d *sql.DB) ([]string, error) {
	return status(context.Background(), d, migrationFiles())
}

func status(ctx context.Context, d *sql.DB, files fs.FS) ([]string, error) {
	var out []string
	if legacy, err := legacyVersion(ctx, d, files); err != nil {
		return nil, err
	} else if legacy > 0 {
		names, err := fs.Glob(files, "*.sql")
		if err != nil {
			return nil, err
		}
		for i, n := range names {
			state := "pending"
			if int64(i+1) <= legacy {
				state = "applied"
			}
			out = append(out, fmt.Sprintf("%-8s %s", state, n))
		}
		return out, nil
	}
	p, err := goosestrict.NewProvider(d, files)
	if err != nil {
		return nil, fmt.Errorf("db: %w", err)
	}
	st, err := p.Status(ctx)
	if err != nil {
		return nil, err
	}
	for _, m := range st {
		state := "pending"
		if m.State == goose.StateApplied {
			state = "applied"
		}
		out = append(out, fmt.Sprintf("%-8s %s", state, m.Source.Path))
	}
	return out, nil
}
