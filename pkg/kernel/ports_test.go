package kernel

import (
	"errors"
	"testing"
)

func TestTailChannelDerivedFromContext(t *testing.T) {
	got, err := TailChannel(sampleTC())
	if err != nil {
		t.Fatal(err)
	}
	if got != "tail:"+testTenantID {
		t.Fatalf("TailChannel = %q, want tail:%s", got, testTenantID)
	}
	if _, err := TailChannel(TenantContext{}); !errors.Is(err, ErrNoTenantContext) {
		t.Fatalf("blank tenant err = %v, want ErrNoTenantContext (fail closed)", err)
	}
}

func TestColdPrefixDerivedFromContext(t *testing.T) {
	got, err := ColdPrefix(sampleTC())
	if err != nil {
		t.Fatal(err)
	}
	if got != "tenant_id="+testTenantID+"/" {
		t.Fatalf("ColdPrefix = %q", got)
	}
	if _, err := ColdPrefix(TenantContext{}); !errors.Is(err, ErrNoTenantContext) {
		t.Fatalf("blank tenant err = %v, want ErrNoTenantContext (fail closed)", err)
	}
}
