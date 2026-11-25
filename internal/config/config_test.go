package config

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8080" || c.HSTS || !c.CookieSecure || c.BaseURL != "" ||
		c.ShutdownTimeout != 10*time.Second || c.DBPath != "" || c.ClientIPHeader != "" {
		t.Errorf("unexpected defaults: %+v", c)
	}
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"ADDR": ":9000", "HSTS": "1", "SHUTDOWN_TIMEOUT": "3s",
		"DB_PATH": "/data/x.db", "CLIENT_IP_HEADER": "CF-Connecting-IP",
		"COOKIE_SECURE": "0", "BASE_URL": "http://local.example:9000",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":9000" || !c.HSTS || c.ShutdownTimeout != 3*time.Second ||
		c.DBPath != "/data/x.db" || c.ClientIPHeader != "CF-Connecting-IP" ||
		c.CookieSecure || c.BaseURL != "http://local.example:9000" {
		t.Errorf("overrides not applied: %+v", c)
	}
}

// Every bad value is reported together, so an operator fixes a deployment in
// one pass rather than one restart per mistake.
func TestLoadReportsAllErrors(t *testing.T) {
	_, err := Load(env(map[string]string{"HSTS": "yes", "SHUTDOWN_TIMEOUT": "-1s"}))
	if err == nil {
		t.Fatal("want error")
	}
	for _, want := range []string{"HSTS", "SHUTDOWN_TIMEOUT"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestSessionLifetimeDefaultsAndOverrides(t *testing.T) {
	for _, tc := range []struct {
		name  string
		env   map[string]string
		hours [4]time.Duration
	}{
		{"defaults", nil, [4]time.Duration{720, 2160, 2160, 8760}},
		{"overrides", map[string]string{
			"SESSION_IDLE": "8h", "SESSION_ABSOLUTE": "24h",
			"DEVICE_SESSION_IDLE": "36h", "DEVICE_SESSION_ABSOLUTE": "96h",
		}, [4]time.Duration{8, 24, 36, 96}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := Load(env(tc.env))
			if err != nil {
				t.Fatal(err)
			}
			web, device := cfg.Lifetimes.Web, cfg.Lifetimes.Device
			got := [4]time.Duration{web.Idle / time.Hour, web.Absolute / time.Hour, device.Idle / time.Hour, device.Absolute / time.Hour}
			if got != tc.hours || web.IdleOff || device.IdleOff {
				t.Fatalf("lifetimes = %+v; want hours %v, idle enabled", cfg.Lifetimes, tc.hours)
			}
		})
	}
}

func TestSessionLifetimeRejectsInvalidSettings(t *testing.T) {
	for _, key := range []string{"SESSION_IDLE", "SESSION_ABSOLUTE", "DEVICE_SESSION_IDLE", "DEVICE_SESSION_ABSOLUTE"} {
		for _, bad := range []string{"0s", "-1h", "30d", " 24h ", "off", "1100ms", "999999999999999h"} {
			t.Run(key+"/"+bad, func(t *testing.T) {
				if _, err := Load(env(map[string]string{key: bad})); err == nil || !strings.Contains(err.Error(), key) {
					t.Fatalf("expected an error naming %s; got %v", key, err)
				}
			})
		}
	}
	_, err := Load(env(map[string]string{
		"SESSION_IDLE": "48h", "SESSION_ABSOLUTE": "24h",
		"DEVICE_SESSION_IDLE": "48h", "DEVICE_SESSION_ABSOLUTE": "24h",
	}))
	for _, want := range []string{"SESSION_IDLE/SESSION_ABSOLUTE:", "DEVICE_SESSION_IDLE/DEVICE_SESSION_ABSOLUTE:"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("invalid range not rejected for %s: %v", want, err)
		}
	}
}

func TestCookieSecure(t *testing.T) {
	for in, want := range map[string]bool{"": true, "1": true, "true": true, "0": false, "false": false} {
		t.Run("accepts_"+in, func(t *testing.T) {
			c, err := Load(env(map[string]string{"COOKIE_SECURE": in}))
			if err != nil || c.CookieSecure != want {
				t.Errorf("%q: %t %v", in, c.CookieSecure, err)
			}
		})
	}
	for _, in := range []string{"auto", "AUTO", "TRUE", " true ", "maybe"} {
		t.Run("rejects_"+in, func(t *testing.T) {
			_, err := Load(env(map[string]string{"COOKIE_SECURE": in}))
			if err == nil || !strings.Contains(err.Error(), "COOKIE_SECURE") {
				t.Fatalf("expected a COOKIE_SECURE error, got %v", err)
			}
			if in == "auto" && !strings.Contains(err.Error(), "no longer supported") {
				t.Errorf("error does not explain the removal of auto: %v", err)
			}
		})
	}
}

func TestBaseURL(t *testing.T) {
	for _, tc := range []struct {
		name, url, secure string
		valid             bool
	}{
		{"optional", "", "", true},
		{"public", "https://example.com", "", true},
		{"LAN", "http://192.0.2.1:8080", "0", true},
		{"http_with_secure_cookie", "http://example.com", "1", false},
		{"path", "https://example.com/account", "", false},
		{"trailing_slash", "https://example.com/", "", false},
		{"uppercase", "https://Example.com", "", false},
		{"default_port", "https://example.com:443", "", false},
		{"bare_host", "example.com", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := Load(env(map[string]string{"BASE_URL": tc.url, "COOKIE_SECURE": tc.secure}))
			if tc.valid {
				if err != nil || c.BaseURL != tc.url {
					t.Fatalf("BaseURL = %q, err = %v; want %q", c.BaseURL, err, tc.url)
				}
			} else if err == nil || !strings.Contains(err.Error(), "BASE_URL") {
				t.Fatalf("expected a BASE_URL error, got %v", err)
			}
		})
	}
}

// CLIENT_IP_HEADER becomes a policy: unset is the peer, a configured header is
// trusted, anything else (an invalid header name) fails at startup.
func TestLoadClientIPSource(t *testing.T) {
	req := func(peer string, hdr map[string]string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = peer
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		return r
	}
	spoof := map[string]string{"CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.8"}

	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", spoof)).String(); got != "10.0.0.1" {
		t.Errorf("unset: %s, want the peer", got)
	}

	c, err = Load(env(map[string]string{"CLIENT_IP_HEADER": "cf-connecting-ip"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", spoof)).String(); got != "203.0.113.9" {
		t.Errorf("configured: %s, want the header", got)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", map[string]string{"X-Forwarded-For": "203.0.113.8"})).String(); got != "10.0.0.1" {
		t.Errorf("other headers must not count: %s", got)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", map[string]string{"CF-Connecting-IP": "junk"})).String(); got != "10.0.0.1" {
		t.Errorf("junk header: %s, want the peer", got)
	}

	if _, err := Load(env(map[string]string{"CLIENT_IP_HEADER": "Bad Header"})); err == nil || !strings.Contains(err.Error(), "CLIENT_IP_HEADER") {
		t.Errorf("invalid header name accepted: %v", err)
	}
}
