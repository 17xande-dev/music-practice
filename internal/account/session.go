package account

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"time"

	"github.com/17xande-dev/music-practice/internal/auth"
	"github.com/17xande-dev/websec/session"
)

// Session kinds: a browser holds a cookie, the iPad app a bearer token.
const (
	KindWeb    = "web"
	KindDevice = "device"
)

// Lifetimes keeps browser and iPad policies separate because they are used
// on different schedules.
type Lifetimes struct {
	Web, Device session.Lifetime
}

// DefaultLifetimes returns the server policies before environment overrides.
func DefaultLifetimes() Lifetimes {
	const day = 24 * time.Hour
	return Lifetimes{
		Web:    session.Lifetime{Idle: 30 * day, Absolute: 90 * day},
		Device: session.Lifetime{Idle: 90 * day, Absolute: 365 * day},
	}
}

// Lifetime returns the policy for one of the two kinds allowed by the schema.
func (s *Store) Lifetime(kind string) session.Lifetime {
	if kind == KindDevice {
		return s.lifetimes.Device
	}
	return s.lifetimes.Web
}

// touchInterval bounds how often a session's last-use time is written, so a
// page load is not a database write.
const touchInterval = time.Hour

// Session is one signed-in browser or device.
type Session struct {
	ID         int64
	UserID     int64
	Kind       string
	Label      string
	CreatedAt  time.Time
	LastUsedAt time.Time
	// ExpiresAt is derived from the policy and the recorded timestamps, not
	// read from the rollback-only expires_at column.
	ExpiresAt time.Time
}

// SignIn signs a user in and returns the token to hand to the client; only
// the token's hash is stored. The caller has just verified the password: the
// session is inserted only while the stored hash is still the one that
// was verified and the account is enabled, in the same statement, so a
// sign-in that overlaps a password reset (which deletes the user's sessions)
// cannot end up holding one. It returns ErrStaleCredentials otherwise.
func (s *Store) SignIn(ctx context.Context, u User, kind, label string) (string, Session, error) {
	return s.createSession(ctx, u.ID, u.PasswordHash, true, kind, label)
}

func (s *Store) createSession(ctx context.Context, userID int64, verifiedHash string, guard bool, kind, label string) (string, Session, error) {
	token := auth.NewToken()
	now := s.now().UTC().Truncate(time.Second)
	expires := s.Lifetime(kind).ExpiresAt(now, now)
	// Range gives byte offsets at rune boundaries, so an iPad name stays UTF-8.
	n := 0
	for i := range label {
		if n == 100 {
			label = label[:i]
			break
		}
		n++
	}
	var res sql.Result
	var err error
	if guard {
		res, err = s.db.ExecContext(ctx, `INSERT INTO auth_sessions
			(token_hash, user_id, kind, label, created_at, last_used_at, expires_at)
			SELECT ?, id, ?, ?, ?, ?, ? FROM users
			WHERE id = ? AND password_hash = ? AND disabled = 0`,
			auth.HashToken(token), kind, label, timestamp(now), timestamp(now), timestamp(expires), userID, verifiedHash)
	} else {
		res, err = s.db.ExecContext(ctx, `INSERT INTO auth_sessions
			(token_hash, user_id, kind, label, created_at, last_used_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			auth.HashToken(token), userID, kind, label, timestamp(now), timestamp(now), timestamp(expires))
	}
	if err != nil {
		return "", Session{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", Session{}, ErrStaleCredentials
	}
	id, _ := res.LastInsertId()
	return token, Session{ID: id, UserID: userID, Kind: kind, Label: label, CreatedAt: now, LastUsedAt: now, ExpiresAt: expires}, nil
}

// Authenticate resolves a token to its session and user. A missing, expired
// or revoked token, or a disabled user, is ErrNotFound: to the caller all of
// them mean "not signed in".
func (s *Store) Authenticate(ctx context.Context, token string) (User, Session, error) {
	if token == "" {
		return User{}, Session{}, ErrNotFound
	}
	var sess Session
	var created, lastUsed string
	hash := auth.HashToken(token)
	row := s.db.QueryRowContext(ctx, `SELECT a.id, a.user_id, a.kind, a.label, a.created_at, a.last_used_at
		FROM auth_sessions a JOIN users u ON u.id = a.user_id
		WHERE a.token_hash = ? AND u.disabled = 0`, hash)
	err := row.Scan(&sess.ID, &sess.UserID, &sess.Kind, &sess.Label, &created, &lastUsed)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, Session{}, ErrNotFound
	}
	if err != nil {
		return User{}, Session{}, err
	}
	sess.CreatedAt, sess.LastUsedAt = parseTime(created), parseTime(lastUsed)
	life := s.Lifetime(sess.Kind)
	now := s.now()
	if life.Expired(sess.CreatedAt, sess.LastUsedAt, now) {
		// Refuse the token even if cleanup fails. Don't delete a row whose
		// last use changed since the read (a concurrent request may have touched it).
		if _, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE token_hash = ? AND last_used_at = ?`, hash, lastUsed); err != nil {
			slog.ErrorContext(ctx, "delete expired session", "session_id", sess.ID, "error", err)
		}
		return User{}, Session{}, ErrNotFound
	}
	sess.ExpiresAt = life.ExpiresAt(sess.CreatedAt, sess.LastUsedAt)
	if session.NeedsTouchAfter(sess.LastUsedAt, now, touchInterval) {
		last := now.UTC().Truncate(time.Second)
		expires := life.ExpiresAt(sess.CreatedAt, last)
		// Repeat the throttle in SQL so concurrent requests don't all write.
		// A failed maintenance write does not invalidate a live session.
		res, err := s.db.ExecContext(ctx, `UPDATE auth_sessions SET last_used_at = ?, expires_at = ?
			WHERE token_hash = ? AND (last_used_at <= ? OR last_used_at > ?)`,
			timestamp(last), timestamp(expires), hash, timestamp(last.Add(-touchInterval)), timestamp(last))
		if err != nil {
			slog.ErrorContext(ctx, "touch session", "session_id", sess.ID, "error", err)
		} else if n, _ := res.RowsAffected(); n > 0 {
			sess.LastUsedAt, sess.ExpiresAt = last, expires
		}
	}
	u, err := s.ByID(ctx, sess.UserID)
	if err != nil {
		return User{}, Session{}, err
	}
	return u, sess, nil
}

// expiredSessions is shared by both lists and the sweep so they agree on
// which rows are live. Fixed-width UTC timestamps sort as time; max mirrors
// the kit's rule that activity before creation counts as creation.
const expiredSessions = `((kind = ? AND (created_at <= ? OR max(created_at, last_used_at) <= ?))
	OR (kind = ? AND (created_at <= ? OR max(created_at, last_used_at) <= ?)))`

func (s *Store) expiryCutoffs(now time.Time) []any {
	var args []any
	for _, kind := range []string{KindWeb, KindDevice} {
		life := s.Lifetime(kind)
		idle := life.Idle
		if life.IdleOff {
			idle = life.Absolute // Idle can no longer end the session before Absolute.
		}
		args = append(args, kind, timestamp(now.Add(-life.Absolute)), timestamp(now.Add(-idle)))
	}
	return args
}

// Sessions lists a user's live sessions, most recently used first.
func (s *Store) Sessions(ctx context.Context, userID int64) ([]Session, error) {
	args := append([]any{userID}, s.expiryCutoffs(s.now())...)
	rows, err := s.db.QueryContext(ctx, `SELECT id, user_id, kind, label, created_at, last_used_at
		FROM auth_sessions WHERE user_id = ? AND NOT `+expiredSessions+`
		ORDER BY last_used_at DESC, id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var sess Session
		var created, lastUsed string
		if err := rows.Scan(&sess.ID, &sess.UserID, &sess.Kind, &sess.Label, &created, &lastUsed); err != nil {
			return nil, err
		}
		sess.CreatedAt, sess.LastUsedAt = parseTime(created), parseTime(lastUsed)
		sess.ExpiresAt = s.Lifetime(sess.Kind).ExpiresAt(sess.CreatedAt, sess.LastUsedAt)
		out = append(out, sess)
	}
	return out, rows.Err()
}

// Revoke ends one of a user's sessions. Scoped to the user in the statement,
// so a guessed session id cannot sign someone else out.
func (s *Store) Revoke(ctx context.Context, userID, sessionID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id = ? AND user_id = ?`, sessionID, userID)
	return err
}

// RevokeToken ends the session a token belongs to (sign out).
func (s *Store) RevokeToken(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE token_hash = ?`, auth.HashToken(token))
	return err
}

// RevokeAll signs a user out everywhere.
func (s *Store) RevokeAll(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE user_id = ?`, userID)
	return err
}

// DeleteExpired sweeps both credential kinds so abandoned sign-ins don't
// accumulate. It returns the number removed.
func (s *Store) DeleteExpired(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE `+expiredSessions, s.expiryCutoffs(s.now())...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
