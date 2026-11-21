package db

import (
	"context"
	"database/sql"
	"testing"

	"github.com/17xande-dev/sqlitekit"
)

// SetCheckForTest swaps the settings check for the length of one test.
func SetCheckForTest(t *testing.T, f func(context.Context, *sql.DB, sqlitekit.Options) error) {
	old := checkSettings
	checkSettings = f
	t.Cleanup(func() { checkSettings = old })
}
