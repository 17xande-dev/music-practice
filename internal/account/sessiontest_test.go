package account_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/music-practice/internal/auth"
	"github.com/17xande-dev/music-practice/internal/dbtest"
	"github.com/17xande-dev/music-practice/internal/handler"
	"github.com/17xande-dev/music-practice/internal/history"
	"github.com/17xande-dev/websec/session"
	"github.com/17xande-dev/websec/session/sessiontest"
)

const (
	suitePassword = "a test session passphrase"
	suiteCookie   = "__Host-mp_session"
)

func TestSessionStoreConformance(t *testing.T) {
	lives := account.DefaultLifetimes()
	for _, tc := range []struct {
		kind string
		life session.Lifetime
	}{
		{account.KindWeb, lives.Web},
		{account.KindDevice, lives.Device},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			d := dbtest.New(t)
			store := account.NewStore(d, lives)
			opts := handler.Options{
				Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Accounts: store,
				History: history.NewStore(d), CookieSecure: true,
			}
			newRoutes := func(t *testing.T) http.Handler {
				t.Helper()
				h, err := handler.New(opts)
				if err != nil {
					t.Fatal(err)
				}
				return h.Routes()
			}
			routes := newRoutes(t)
			pw, err := auth.HashPassword(t.Context(), suitePassword)
			if err != nil {
				t.Fatal(err)
			}
			users := map[string]int64{}
			newUser := func(t *testing.T, admin bool) string {
				t.Helper()
				email := fmt.Sprintf("suite-%d@example.com", len(users)+1)
				u, err := store.Create(t.Context(), email, pw, admin)
				if err != nil {
					t.Fatal(err)
				}
				users[email] = u.ID
				return email
			}
			admin := webLogin(t, routes, newUser(t, true))
			adminAction := func(t *testing.T, user, action, notice string) {
				t.Helper()
				path := fmt.Sprintf("/admin/users/%d/%s", users[user], action)
				r := sessionRequest(http.MethodPost, path, "", "", suiteCookie, admin)
				rec := serveSession(routes, r)
				if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/admin/users?notice="+notice {
					t.Fatalf("admin %s: got status %d, want a successful redirect", action, rec.Code)
				}
			}

			issueRoutes := newRoutes(t)
			var issued int
			harness := sessiontest.Harness{
				Lifetime:   tc.life,
				TouchEvery: time.Hour,
				// Cookies cannot carry NUL/newline. Neither can on-wire bearer
				// headers, so use the suite's legal-header variants for both.
				CookieTokens: true,
				NewUser:      func(t *testing.T) string { return newUser(t, false) },
				Create: func(t *testing.T, user string) string {
					t.Helper()
					// The suite creates 100 tokens for one user. Give each batch
					// a fresh limiter, but never bypass the production routes.
					if issued != 0 && issued%4 == 0 {
						issueRoutes = newRoutes(t)
					}
					issued++
					if tc.kind == account.KindWeb {
						return webLogin(t, issueRoutes, user)
					}
					return deviceLogin(t, issueRoutes, user)
				},
				Lookup: func(t *testing.T, token string) (string, bool, error) {
					r := sessionRequest(http.MethodGet, "/api/me", "", "", "", "")
					if tc.kind == account.KindWeb {
						r.AddCookie(&http.Cookie{Name: suiteCookie, Value: token})
					} else {
						r.Header.Set("Authorization", "Bearer "+token)
					}
					rec := serveSession(routes, r)
					switch rec.Code {
					case http.StatusUnauthorized:
						return "", false, nil
					case http.StatusOK:
						var v struct{ Email string }
						err := json.Unmarshal(rec.Body.Bytes(), &v)
						return v.Email, err == nil, err
					default:
						return "", false, fmt.Errorf("lookup status %d", rec.Code)
					}
				},
				Backdate: func(t *testing.T, token string, created, last time.Time) {
					t.Helper()
					created, last = created.Truncate(time.Second), last.Truncate(time.Second)
					res, err := d.ExecContext(t.Context(), `UPDATE auth_sessions
						SET created_at = ?, last_used_at = ?, expires_at = ? WHERE token_hash = ?`,
						stamp(created), stamp(last), stamp(tc.life.ExpiresAt(created, last)), fixtureHash(token))
					if err != nil {
						t.Fatal(err)
					}
					if n, err := res.RowsAffected(); err != nil || n != 1 {
						t.Fatalf("backdate changed %d rows: %v", n, err)
					}
				},
				LastSeen: func(t *testing.T, token string) time.Time {
					t.Helper()
					var last string
					if err := d.QueryRowContext(t.Context(), `SELECT last_used_at FROM auth_sessions WHERE token_hash = ?`, fixtureHash(token)).Scan(&last); err != nil {
						t.Fatal(err)
					}
					at, err := time.Parse(time.RFC3339, last)
					if err != nil {
						t.Fatal(err)
					}
					return at
				},
				Sweep: func(t *testing.T) int {
					t.Helper()
					n, err := store.DeleteExpired(t.Context())
					if err != nil {
						t.Fatal(err)
					}
					return int(n)
				},
				Count: func(t *testing.T) int {
					t.Helper()
					var n int
					if err := d.QueryRowContext(t.Context(), `SELECT count(*) FROM auth_sessions`).Scan(&n); err != nil {
						t.Fatal(err)
					}
					return n
				},
				RawRows: func(t *testing.T) []string {
					t.Helper()
					rows, err := d.QueryContext(t.Context(), `SELECT id, token_hash, user_id, kind, label, created_at, last_used_at, expires_at FROM auth_sessions`)
					if err != nil {
						t.Fatal(err)
					}
					defer rows.Close()
					var out []string
					for rows.Next() {
						var id, user int64
						var hash, kind, label, created, last, expires string
						if err := rows.Scan(&id, &hash, &user, &kind, &label, &created, &last, &expires); err != nil {
							t.Fatal(err)
						}
						out = append(out, fmt.Sprintf("%d|%s|%d|%s|%s|%s|%s|%s", id, hash, user, kind, label, created, last, expires))
					}
					if err := rows.Err(); err != nil {
						t.Fatal(err)
					}
					return out
				},
				Disable:    func(t *testing.T, user string) { adminAction(t, user, "disable", "disabled") },
				RevokeUser: func(t *testing.T, user string) { adminAction(t, user, "signout", "signed-out") },
			}
			if tc.kind == account.KindWeb {
				harness.ChangePassword = func(t *testing.T, user, current string) string {
					t.Helper()
					device := deviceLogin(t, newRoutes(t), user)
					body := url.Values{"current": {suitePassword}, "new": {"another test passphrase"}, "confirm": {"another test passphrase"}}
					rec := serveSession(routes, sessionRequest(http.MethodPost, "/account/password", "application/x-www-form-urlencoded", body.Encode(), suiteCookie, current))
					if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/account?notice=password-changed" {
						t.Fatalf("change own password: got status %d, want a successful redirect", rec.Code)
					}
					r := sessionRequest(http.MethodGet, "/api/me", "", "", "", "")
					r.Header.Set("Authorization", "Bearer "+device)
					if rec := serveSession(routes, r); rec.Code != http.StatusUnauthorized {
						t.Fatalf("device after own password change: status %d, want 401", rec.Code)
					}
					return current
				}
			} else {
				harness.NotApplicable = map[sessiontest.Case]string{
					sessiontest.CasePasswordChange: "own password change runs only from a browser session; device rows end via the web harness case and TestSetPasswordEndsOtherSessions",
				}
			}
			sessiontest.Run(t, harness)
		})
	}
}

func webLogin(t *testing.T, routes http.Handler, user string) string {
	t.Helper()
	body := url.Values{"email": {user}, "password": {suitePassword}}
	rec := serveSession(routes, sessionRequest(http.MethodPost, "/account/login", "application/x-www-form-urlencoded", body.Encode(), "", ""))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("web login: status %d", rec.Code)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == suiteCookie && c.Value != "" {
			return c.Value
		}
	}
	t.Fatal("web login: no session cookie")
	return ""
}

func deviceLogin(t *testing.T, routes http.Handler, user string) string {
	t.Helper()
	body := fmt.Sprintf(`{"email":%q,"password":%q,"label":"iPad"}`, user, suitePassword)
	rec := serveSession(routes, sessionRequest(http.MethodPost, "/api/token", "application/json", body, "", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("issue device token: status %d", rec.Code)
	}
	var v struct{ Email, Token string }
	if json.Unmarshal(rec.Body.Bytes(), &v) != nil || v.Email != user || v.Token == "" {
		t.Fatal("issue device token: invalid response")
	}
	return v.Token
}

func sessionRequest(method, path, ctype, body, name, value string) *http.Request {
	r := httptest.NewRequest(method, "https://example.com"+path, strings.NewReader(body))
	if ctype != "" {
		r.Header.Set("Content-Type", ctype)
	}
	if name != "" {
		r.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	return r
}

func serveSession(routes http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	routes.ServeHTTP(rec, r)
	return rec
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func fixtureHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
