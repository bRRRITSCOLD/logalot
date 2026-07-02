package config

import "testing"

// baseEnv sets the minimum env required for Load to succeed, so each test only
// needs to override what it cares about.
func baseEnv(t *testing.T) {
	t.Helper()
	t.Setenv(EvaluatorDatabaseURLEnv, "postgres://evaluator@localhost/db")
	t.Setenv(AppDatabaseURLEnv, "postgres://app@localhost/db")
}

func TestLoad_RequiresBothDatabaseURLs(t *testing.T) {
	t.Setenv(EvaluatorDatabaseURLEnv, "")
	t.Setenv(AppDatabaseURLEnv, "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when both DB URLs are unset")
	}
}

func TestLoad_SMTPUnsetMeansEmailDisabledByDefault(t *testing.T) {
	baseEnv(t)
	t.Setenv(SMTPHostEnv, "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SMTPHost != "" {
		t.Fatalf("expected SMTPHost empty by default, got %q", cfg.SMTPHost)
	}
}

func TestLoad_SMTPHostRequiresFromAndPort(t *testing.T) {
	baseEnv(t)
	t.Setenv(SMTPHostEnv, "mailhog")
	t.Setenv(SMTPFromEnv, "")
	t.Setenv(SMTPPortEnv, "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: SMTP_HOST set without SMTP_FROM/SMTP_PORT")
	}

	t.Setenv(SMTPFromEnv, "alerts@logalot.local")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: SMTP_HOST+SMTP_FROM set without SMTP_PORT")
	}
}

func TestLoad_SMTPPortMustBeAPositiveInt(t *testing.T) {
	baseEnv(t)
	t.Setenv(SMTPHostEnv, "mailhog")
	t.Setenv(SMTPFromEnv, "alerts@logalot.local")
	t.Setenv(SMTPPortEnv, "not-a-number")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for non-numeric SMTP_PORT")
	}
}

func TestLoad_SMTPFullyConfiguredSucceeds(t *testing.T) {
	baseEnv(t)
	t.Setenv(SMTPHostEnv, "mailhog")
	t.Setenv(SMTPFromEnv, "alerts@logalot.local")
	t.Setenv(SMTPPortEnv, "1025")
	t.Setenv(SMTPUserEnv, "")
	t.Setenv(SMTPPassEnv, "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SMTPHost != "mailhog" || cfg.SMTPPort != 1025 || cfg.SMTPFrom != "alerts@logalot.local" {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestLoad_SMTPUserWithoutPassFailsClosed(t *testing.T) {
	baseEnv(t)
	t.Setenv(SMTPHostEnv, "mailhog")
	t.Setenv(SMTPFromEnv, "alerts@logalot.local")
	t.Setenv(SMTPPortEnv, "1025")
	t.Setenv(SMTPUserEnv, "someuser")
	t.Setenv(SMTPPassEnv, "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: SMTP_USER set without SMTP_PASS")
	}
}

func TestLoad_SMTPPassWithoutUserFailsClosed(t *testing.T) {
	baseEnv(t)
	t.Setenv(SMTPHostEnv, "mailhog")
	t.Setenv(SMTPFromEnv, "alerts@logalot.local")
	t.Setenv(SMTPPortEnv, "1025")
	t.Setenv(SMTPUserEnv, "")
	t.Setenv(SMTPPassEnv, "somepass")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: SMTP_PASS set without SMTP_USER")
	}
}

func TestLoad_UnknownNotifierFailsClosed(t *testing.T) {
	baseEnv(t)
	t.Setenv(NotifierEnv, "carrier-pigeon")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for unknown notifier")
	}
}
