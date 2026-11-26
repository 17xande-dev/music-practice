// Package config turns the environment into one Config struct. Every setting
// the server reads is parsed here and nowhere else, so the list below is the
// complete surface an operator can turn.
package config

import (
	"fmt"
	"os"
	"time"

	"github.com/17xande-dev/env"
	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/ratelimit/clientip"
	"github.com/17xande-dev/websec/csrf"
	"github.com/17xande-dev/websec/session"
)

// Config is the whole runtime configuration.
type Config struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string

	// HSTS adds Strict-Transport-Security. Only for an https deployment:
	// sent from a plain-HTTP localhost it pins a rule that breaks the next
	// project on that port.
	HSTS bool

	// CookieSecure follows the deployment, not the connection behind its proxy.
	CookieSecure bool

	// BaseURL is the optional public origin, without a path or a trailing slash.
	BaseURL string

	// Lifetimes applies to existing as well as newly issued sessions.
	Lifetimes account.Lifetimes

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

	// ClientIP is the policy built from ClientIPHeader, for rate limiting.
	ClientIP clientip.Source
}

// Load reads the process environment and reports every invalid setting at
// once rather than the first.
func Load() (Config, error) { return load(os.LookupEnv) }

// load takes the lookup so tests can supply an environment without touching
// the process's.
func load(lookup env.Lookup) (Config, error) {
	r := env.New(lookup)
	c := Config{
		Addr:            r.String("ADDR", ":8080"),
		HSTS:            r.Bool("HSTS", false),
		BaseURL:         r.String("BASE_URL", ""),
		ShutdownTimeout: r.Duration("SHUTDOWN_TIMEOUT", 10*time.Second, time.Nanosecond, 0),
		Lifetimes:       account.DefaultLifetimes(),
		DBPath:          r.String("DB_PATH", ""),
		ClientIPHeader:  r.String("CLIENT_IP_HEADER", ""),
	}
	// "auto" was a supported spelling once; say what replaced it rather than
	// the generic boolean message.
	if value, _ := lookup("COOKIE_SECURE"); value == "auto" {
		r.Fail("COOKIE_SECURE", "auto is no longer supported; use true for HTTPS or false for plain HTTP")
		c.CookieSecure = true
	} else {
		c.CookieSecure = r.Bool("COOKIE_SECURE", true)
	}

	if c.BaseURL != "" {
		if err := csrf.ValidateOrigin(c.BaseURL, !c.CookieSecure); err != nil {
			// A pasted URL might contain userinfo; do not echo its value.
			r.Fail("BASE_URL", "want a canonical origin (scheme://host[:port], no path); HTTPS is required when COOKIE_SECURE is true")
		}
	}

	loadLifetime(r, "SESSION", &c.Lifetimes.Web)
	loadLifetime(r, "DEVICE_SESSION", &c.Lifetimes.Device)

	if src, err := clientip.New(clientip.Config{TrustedHeader: c.ClientIPHeader}); err != nil {
		r.Fail("CLIENT_IP_HEADER", "must be a valid header name")
	} else {
		c.ClientIP = src
	}

	if err := r.Err(); err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	return c, nil
}

func loadLifetime(r *env.Reader, prefix string, life *session.Lifetime) {
	idle, absolute := prefix+"_IDLE", prefix+"_ABSOLUTE"
	for _, v := range []struct {
		key string
		dst *time.Duration
	}{{idle, &life.Idle}, {absolute, &life.Absolute}} {
		// The existing RFC3339 columns and cookie deadlines have second
		// precision, so fractions are refused; the minimum excludes zero and
		// negative values.
		*v.dst = r.Duration(v.key, *v.dst, time.Second, 0)
		if *v.dst%time.Second != 0 {
			r.Fail(v.key, "want a positive whole-second duration like 720h")
		}
	}
	if err := life.Validate(); err != nil {
		r.Fail(idle+"/"+absolute, "the idle limit must not exceed the absolute limit")
	}
}
