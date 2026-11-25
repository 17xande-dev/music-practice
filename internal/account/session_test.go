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
	now = now.Add(s.Lifetime(KindWeb).Idle)
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

func TestTouchCapsDerivedExpiryAtAbsoluteDeadline(t *testing.T) {
	for _, kind := range []string{KindWeb, KindDevice} {
		t.Run(kind, func(t *testing.T) {
			s := newStore(t)
			u := mustCreate(t, s, "u@example.com", false)
			life := s.Lifetime(kind)
			created := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			now := created
			s.now = func() time.Time { return now }
			token, sess, err := s.SignIn(t.Context(), u, kind, "")
			if err != nil {
				t.Fatal(err)
			}
			storedExpiry := func() string {
				t.Helper()
				var expiry string
				if err := s.db.QueryRowContext(t.Context(), `SELECT expires_at FROM auth_sessions WHERE id = ?`, sess.ID).Scan(&expiry); err != nil {
					t.Fatal(err)
				}
				return expiry
			}
			if got, want := storedExpiry(), timestamp(created.Add(life.Idle)); got != want {
				t.Fatalf("on creation: stored expiry %s, want %s", got, want)
			}

			cap := created.Add(life.Absolute)
			last := cap.Add(-2 * time.Hour)
			// Near the absolute cap, this session was still active. A due
			// touch must advance last use without pushing the deadline out.
			if _, err := s.db.ExecContext(t.Context(), `UPDATE auth_sessions SET last_used_at = ? WHERE id = ?`, timestamp(last), sess.ID); err != nil {
				t.Fatal(err)
			}
			now = cap.Add(-time.Hour)
			_, touched, err := s.Authenticate(t.Context(), token)
			if err != nil || !touched.LastUsedAt.Equal(now) || !touched.ExpiresAt.Equal(cap) {
				t.Fatalf("touch before the cap: last use %v, expiry %v, err %v", touched.LastUsedAt, touched.ExpiresAt, err)
			}
			if got := storedExpiry(); got != timestamp(cap) {
				t.Fatalf("stored expiry after touch = %s; want absolute deadline %s", got, cap)
			}
			now = cap
			if _, _, err := s.Authenticate(t.Context(), token); !errors.Is(err, ErrNotFound) {
				t.Fatalf("session at the absolute deadline: %v; want ErrNotFound", err)
			}
		})
	}
}

func TestSessionListsAndSweepUseKindDeadlines(t *testing.T) {
	s := newStore(t)
	now := time.Date(2026, 11, 25, 15, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	u := mustCreate(t, s, "u@example.com", false)
	const day = 24 * time.Hour
	live := map[int64]time.Time{}
	dead := 0
	for _, tc := range []struct {
		kind         string
		age, idleFor time.Duration
		oldExpiry    string
		liveUntil    time.Time
	}{
		{KindWeb, 30 * day, 30 * day, "2099-01-01T00:00:00Z", time.Time{}},
		{KindDevice, 365 * day, 0, "", time.Time{}},
		{KindDevice, 90 * day, 90 * day, "", time.Time{}},
		{KindDevice, 180 * day, 60 * day, "", now.Add(30 * day)},
		// A clock step made last use precede creation. Counting it as
		// creation keeps the web row live despite its old expires_at.
		{KindWeb, day, 60 * day, "2026-01-01T00:00:00Z", now.Add(29 * day)},
		// Every deadline to the second: exactly at it the row is gone, one
		// second before it the row is live until that second.
		{KindWeb, 90 * day, 0, "", time.Time{}},
		{KindWeb, 90*day - time.Second, 0, "", now.Add(time.Second)},
		{KindWeb, 40 * day, 30 * day, "", time.Time{}},
		{KindWeb, 40 * day, 30*day - time.Second, "", now.Add(time.Second)},
		{KindDevice, 365*day - time.Second, 0, "", now.Add(time.Second)},
		{KindDevice, 100 * day, 90*day - time.Second, "", now.Add(time.Second)},
		// Last use before creation counts as creation, for devices too: the
		// row lives to created+90d, not "idle since the older timestamp".
		{KindDevice, 10 * day, 200 * day, "", now.Add(80 * day)},
		{KindDevice, 90 * day, 200 * day, "", time.Time{}},
	} {
		_, sess, err := s.SignIn(t.Context(), u, tc.kind, "")
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.db.ExecContext(t.Context(), `UPDATE auth_sessions SET created_at = ?, last_used_at = ?, expires_at = ? WHERE id = ?`,
			timestamp(now.Add(-tc.age)), timestamp(now.Add(-tc.idleFor)), tc.oldExpiry, sess.ID)
		if err != nil {
			t.Fatal(err)
		}
		if tc.liveUntil.IsZero() {
			dead++
		} else {
			live[sess.ID] = tc.liveUntil
		}
	}
	sessions, err := s.Sessions(t.Context(), u.ID)
	if err != nil || len(sessions) != len(live) {
		t.Fatalf("account session list got %d rows; want %d: %v", len(sessions), len(live), err)
	}
	for _, sess := range sessions {
		if want := live[sess.ID]; want.IsZero() || !sess.ExpiresAt.Equal(want) {
			t.Errorf("unexpected listed session %d with derived expiry %s; want %s", sess.ID, sess.ExpiresAt, want)
		}
	}
	users, err := s.List(t.Context())
	if err != nil || len(users) != 1 || users[0].Sessions != len(live) {
		t.Fatalf("admin list did not count the same live sessions: %v", err)
	}
	if n, err := s.DeleteExpired(t.Context()); err != nil || n != int64(dead) {
		t.Fatalf("sweep removed %d rows; want %d: %v", n, dead, err)
	}
	for id := range live {
		var n int
		if err := s.db.QueryRowContext(t.Context(), `SELECT count(*) FROM auth_sessions WHERE id = ?`, id).Scan(&n); err != nil || n != 1 {
			t.Fatalf("sweep did not keep live row %d: count=%d, err=%v", id, n, err)
		}
	}
}

// The touch is throttled to once an hour. The SQL repeats the throttle, so its
// boundary must agree with the Go check to the second: one second early is
// not written, exactly an hour and a second later are.
func TestTouchThrottleBoundary(t *testing.T) {
	for _, kind := range []string{KindWeb, KindDevice} {
		for _, tc := range []struct {
			name    string
			since   time.Duration
			touched bool
		}{
			{"one second before the interval", time.Hour - time.Second, false},
			{"exactly the interval", time.Hour, true},
			{"one second after the interval", time.Hour + time.Second, true},
		} {
			t.Run(kind+"/"+tc.name, func(t *testing.T) {
				s := newStore(t)
				u := mustCreate(t, s, "u@example.com", false)
				created := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
				s.now = func() time.Time { return created }
				token, sess, err := s.SignIn(t.Context(), u, kind, "")
				if err != nil {
					t.Fatal(err)
				}
				now := created.Add(tc.since)
				s.now = func() time.Time { return now }
				if _, _, err := s.Authenticate(t.Context(), token); err != nil {
					t.Fatal(err)
				}
				var last string
				if err := s.db.QueryRowContext(t.Context(), `SELECT last_used_at FROM auth_sessions WHERE id = ?`, sess.ID).Scan(&last); err != nil {
					t.Fatal(err)
				}
				want := timestamp(created)
				if tc.touched {
					want = timestamp(now)
				}
				if last != want {
					t.Fatalf("last_used_at = %s; want %s", last, want)
				}
			})
		}
	}
}
