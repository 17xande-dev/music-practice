package account

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestDeviceLabelTruncatesAtRuneBoundary(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@example.com", false)
	want := strings.Repeat("a", 99) + "🎵"
	token, _, err := s.SignIn(t.Context(), u, KindDevice, want+"extra")
	if err != nil {
		t.Fatal(err)
	}
	_, sess, err := s.Authenticate(t.Context(), token)
	if err != nil || sess.Label != want {
		t.Fatalf("stored label = %q, err = %v; want %q", sess.Label, err, want)
	}
}

func TestSessionMaintenanceErrorsAreLogged(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@example.com", false)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	token, _, err := s.SignIn(t.Context(), u, KindWeb, "")
	if err != nil {
		t.Fatal(err)
	}
	// Fail the maintenance writes without failing the reads needed for auth.
	for _, q := range []string{
		`CREATE TRIGGER fail_touch BEFORE UPDATE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'test touch'); END`,
		`CREATE TRIGGER fail_delete BEFORE DELETE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'test delete'); END`,
	} {
		if _, err := s.db.ExecContext(t.Context(), q); err != nil {
			t.Fatal(err)
		}
	}
	var logs bytes.Buffer
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))

	now = now.Add(time.Hour)
	if _, _, err := s.Authenticate(t.Context(), token); err != nil {
		t.Fatalf("touch failure prevented sign-in: %v", err)
	}
	now = now.Add(WebSessionTTL)
	if _, _, err := s.Authenticate(t.Context(), token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed delete of expired session: %v; want ErrNotFound", err)
	}
	for _, msg := range []string{`level=ERROR msg="touch session"`, `level=ERROR msg="delete expired session"`} {
		if !strings.Contains(logs.String(), msg) {
			t.Errorf("missing %s", msg)
		}
	}
	if strings.Contains(logs.String(), token) {
		t.Error("session token leaked into logs")
	}
}
