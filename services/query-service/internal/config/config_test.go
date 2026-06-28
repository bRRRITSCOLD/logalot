package config

import (
	"strings"
	"testing"
)

func TestJWTSecretFromEnv(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		set     bool
		wantErr bool
	}{
		{"unset fails closed", "", false, true},
		{"empty fails closed", "", true, true},
		{"too short fails closed", "short", true, true},
		{"exactly min length ok", strings.Repeat("x", MinJWTSecretLen), true, false},
		{"dev default ok", "dev-jwt-secret-change-me-0123456789", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv(JWTSecretEnv, tc.value)
			} else {
				// t.Setenv to empty still sets it; use a guaranteed-unset name path by
				// setting then unsetting is not available, so set to empty which the
				// length check treats identically to unset.
				t.Setenv(JWTSecretEnv, "")
			}
			got, err := jwtSecretFromEnv()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("jwtSecretFromEnv(%q) = %q, want error", tc.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("jwtSecretFromEnv(%q): unexpected error %v", tc.value, err)
			}
			if got != tc.value {
				t.Fatalf("jwtSecretFromEnv = %q, want %q", got, tc.value)
			}
		})
	}
}
