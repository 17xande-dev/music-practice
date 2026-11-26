package config

import (
	"testing"

	"github.com/17xande-dev/env/envtest"
)

func TestProductionValues(t *testing.T) {
	// Keep these literals in sync with config/deploy.yml and .env.example.
	for name, values := range map[string]map[string]string{
		"config/deploy.yml": {
			"HSTS":                    "true",
			"COOKIE_SECURE":           "true",
			"BASE_URL":                "https://music.17xande.dev",
			"SESSION_IDLE":            "720h",
			"SESSION_ABSOLUTE":        "2160h",
			"DEVICE_SESSION_IDLE":     "2160h",
			"DEVICE_SESSION_ABSOLUTE": "8760h",
			"DB_PATH":                 "/data/music-practice.db",
			"CLIENT_IP_HEADER":        "CF-Connecting-IP",
		},
		".env.example": {
			"COOKIE_SECURE":           "false",
			"BASE_URL":                "http://localhost:8080",
			"DB_PATH":                 "data/dev.db",
			"SESSION_IDLE":            "720h",
			"SESSION_ABSOLUTE":        "2160h",
			"DEVICE_SESSION_IDLE":     "2160h",
			"DEVICE_SESSION_ABSOLUTE": "8760h",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := load(envtest.NewRecorder(values).Lookup); err != nil {
				t.Fatal(err)
			}
		})
	}
}
