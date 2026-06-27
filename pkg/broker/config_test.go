package broker

import "testing"

func TestURLFromEnv_PrefersURL(t *testing.T) {
	t.Setenv(URLEnv, "amqp://u:p@rabbit:5672/")
	t.Setenv(HostEnv, "ignored")
	t.Setenv(PortEnv, "1234")
	got, err := URLFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if got != "amqp://u:p@rabbit:5672/" {
		t.Fatalf("URLFromEnv()=%q, want the RABBITMQ_URL value", got)
	}
}

func TestURLFromEnv_FallbackAssembly(t *testing.T) {
	t.Setenv(URLEnv, "")
	t.Setenv(HostEnv, "localhost")
	t.Setenv(PortEnv, "5672")
	t.Setenv(UserEnv, "logalot")
	t.Setenv(PasswordEnv, "logalot")
	got, err := URLFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if got != "amqp://logalot:logalot@localhost:5672/" {
		t.Fatalf("URLFromEnv()=%q, want assembled amqp url", got)
	}
}

func TestURLFromEnv_FailClosed(t *testing.T) {
	t.Setenv(URLEnv, "")
	t.Setenv(HostEnv, "")
	t.Setenv(PortEnv, "")
	if _, err := URLFromEnv(); err == nil {
		t.Fatal("expected error when neither URL nor host+port are set")
	}
}

func TestResolveConfig_Defaults(t *testing.T) {
	cfg := resolveConfig()
	if cfg.topo != DefaultTopology() {
		t.Error("default topology not applied")
	}
	if !cfg.declare {
		t.Error("declare should default true")
	}
	if cfg.poolSize != defaultPoolSize || cfg.prefetch != defaultPrefetch {
		t.Errorf("pool/prefetch defaults = %d/%d", cfg.poolSize, cfg.prefetch)
	}
}

func TestResolveConfig_OptionsApply(t *testing.T) {
	cfg := resolveConfig(
		WithoutTopologyDeclaration(),
		WithPublisherPoolSize(3),
		WithPrefetch(7),
	)
	if cfg.declare {
		t.Error("WithoutTopologyDeclaration should disable declare")
	}
	if cfg.poolSize != 3 || cfg.prefetch != 7 {
		t.Errorf("options not applied: pool=%d prefetch=%d", cfg.poolSize, cfg.prefetch)
	}
}
