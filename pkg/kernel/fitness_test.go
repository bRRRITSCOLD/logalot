package kernel

import (
	"context"
	"reflect"
	"testing"
)

// TestAllPortsAreTenantScoped is the fitness function for the load-bearing
// invariant (ADR-0002, overview.md §6): no port exposes an un-scoped method.
// Every tenant-scoped port method must take TenantContext as its first argument.
func TestAllPortsAreTenantScoped(t *testing.T) {
	cases := []struct {
		iface reflect.Type
		allow []string
	}{
		{reflect.TypeOf((*LogStore)(nil)).Elem(), nil},
		{reflect.TypeOf((*Broker)(nil)).Elem(), nil},
		{reflect.TypeOf((*TailBus)(nil)).Elem(), nil},
		{reflect.TypeOf((*ColdArchive)(nil)).Elem(), nil},
		{reflect.TypeOf((*KeyStore)(nil)).Elem(), nil},
		{reflect.TypeOf((*TenantStore)(nil)).Elem(), nil},
		// Authenticate is the sanctioned chicken-and-egg exception: it produces
		// the TenantContext, so it cannot require one (model.md §4.5).
		{reflect.TypeOf((*Authenticator)(nil)).Elem(), []string{"Authenticate"}},
	}
	for _, c := range cases {
		t.Run(c.iface.Name(), func(t *testing.T) {
			if v := AssertTenantScoped(c.iface, c.allow...); len(v) != 0 {
				t.Fatalf("un-scoped port method(s): %v", v)
			}
		})
	}
}

// TestAssertTenantScopedCatchesViolation proves the fitness function actually
// fails when a method is NOT tenant-scoped — otherwise it would be a no-op guard.
func TestAssertTenantScopedCatchesViolation(t *testing.T) {
	type Leaky interface {
		ReadAll(ctx context.Context) ([]LogEvent, error) // missing TenantContext
	}
	v := AssertTenantScoped(reflect.TypeOf((*Leaky)(nil)).Elem())
	if len(v) != 1 {
		t.Fatalf("expected exactly 1 violation, got %v", v)
	}
}

// TestAssertTenantScopedHonoursAllowList confirms named exceptions are skipped.
func TestAssertTenantScopedHonoursAllowList(t *testing.T) {
	if v := AssertTenantScoped(reflect.TypeOf((*Authenticator)(nil)).Elem()); len(v) == 0 {
		t.Fatal("Authenticate should be a violation without the allow list")
	}
	if v := AssertTenantScoped(reflect.TypeOf((*Authenticator)(nil)).Elem(), "Authenticate"); len(v) != 0 {
		t.Fatalf("allow list ignored: %v", v)
	}
}

func TestAssertTenantScopedRejectsNonInterface(t *testing.T) {
	if v := AssertTenantScoped(reflect.TypeOf(LogEvent{})); len(v) != 1 {
		t.Fatalf("expected non-interface to report a violation, got %v", v)
	}
}
