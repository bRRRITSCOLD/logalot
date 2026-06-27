package platform

import "testing"

func TestAppDatabaseURL(t *testing.T) {
	t.Setenv(AppDatabaseURLEnv, "postgres://logalot_app:pw@localhost:5432/logalot?sslmode=disable")
	got, err := AppDatabaseURL()
	if err != nil {
		t.Fatalf("AppDatabaseURL error = %v", err)
	}
	if got == "" {
		t.Fatal("expected non-empty dsn")
	}

	t.Setenv(AppDatabaseURLEnv, "")
	if _, err := AppDatabaseURL(); err == nil {
		t.Fatal("expected error when env unset (fail closed)")
	}
}

func TestRedisConfigFromEnv(t *testing.T) {
	t.Setenv(RedisHostEnv, "localhost")
	t.Setenv(RedisPortEnv, "6379")
	t.Setenv(RedisPasswordEnv, "secret")
	cfg, err := RedisConfigFromEnv()
	if err != nil {
		t.Fatalf("RedisConfigFromEnv error = %v", err)
	}
	if cfg.Addr != "localhost:6379" {
		t.Errorf("Addr = %q, want localhost:6379", cfg.Addr)
	}
	if cfg.Password != "secret" {
		t.Errorf("Password = %q", cfg.Password)
	}

	t.Setenv(RedisHostEnv, "")
	if _, err := RedisConfigFromEnv(); err == nil {
		t.Fatal("expected error when host unset")
	}
}
