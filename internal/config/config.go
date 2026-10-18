// Package config turns the environment into one Config struct. Every setting
// the server reads is parsed here and nowhere else, so the list below is the
// complete surface an operator can turn.
package config

import (
	"fmt"
	"strings"
	"time"
)

// Config is the whole runtime configuration.
type Config struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string

	// HSTS adds Strict-Transport-Security. Only for an https deployment:
	// sent from a plain-HTTP localhost it pins a rule that breaks the next
	// project on that port.
	HSTS bool

	// CookieSecure decides the Secure flag on the session cookie: "auto"
	// (the default), "1" (always) or "0" (never). Auto sets Secure unless the
	// request reached the server over plain HTTP directly and HSTS is off,
	// which is how a LAN address like http://192.168.1.5:8080 can sign in.
	// With HSTS on (any real deployment) auto is always Secure.
	CookieSecure string

	// ShutdownTimeout bounds how long in-flight requests get on SIGTERM.
	ShutdownTimeout time.Duration

	// DBPath is the SQLite file holding accounts and synced history. It has
	// no default: a default inside the image would quietly write to the
	// container's own filesystem, and every deploy would wipe it. The server
	// refuses to start without it (the -healthcheck probe does not need it).
	DBPath string

	// ClientIPHeader names the header carrying the visitor's address when a
	// proxy sits in front (CF-Connecting-IP behind Cloudflare). Empty means
	// use the connection's own address. Only set it when every request
	// arrives through that proxy: otherwise anyone can send the header and
	// pick their own rate-limit bucket.
	ClientIPHeader string
}

// Load reads configuration through getenv (os.Getenv in production, a map in
// tests) and reports every invalid value at once rather than the first.
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		Addr:            ":8080",
		CookieSecure:    "auto",
		ShutdownTimeout: 10 * time.Second,
	}
	var errs []string

	if v := getenv("ADDR"); v != "" {
		c.Addr = v
	}

	switch v := getenv("HSTS"); v {
	case "", "0", "false":
	case "1", "true":
		c.HSTS = true
	default:
		errs = append(errs, fmt.Sprintf("HSTS: want 1/0/true/false, got %q", v))
	}

	switch v := strings.ToLower(getenv("COOKIE_SECURE")); v {
	case "", "auto":
	case "1", "true":
		c.CookieSecure = "1"
	case "0", "false":
		c.CookieSecure = "0"
	default:
		errs = append(errs, fmt.Sprintf("COOKIE_SECURE: want auto/1/0/true/false, got %q", v))
	}

	if v := getenv("SHUTDOWN_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			errs = append(errs, fmt.Sprintf("SHUTDOWN_TIMEOUT: want a positive duration like 10s, got %q", v))
		} else {
			c.ShutdownTimeout = d
		}
	}

	c.DBPath = getenv("DB_PATH")
	c.ClientIPHeader = getenv("CLIENT_IP_HEADER")

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("config: %s", strings.Join(errs, "; "))
	}
	return c, nil
}
