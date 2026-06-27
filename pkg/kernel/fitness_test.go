package kernel

import (
	"context"
	"reflect"
	"testing"
)

// TestAllPortsAreTenantScoped is the fitness function for the load-bearing
// invariant (ADR-0002, overview.md §6): no port exposes an un-scoped method.
// It iterates the AllPorts registry (single source of truth) so a newly declared
// port is covered automatically once registered — and slips through if it is
// not, which is why registration is mandated at the port declarations.
func TestAllPortsAreTenantScoped(t *testing.T) {
	if len(AllPorts) == 0 {
		t.Fatal("AllPorts is empty: ports must be registered")
	}
	for _, p := range AllPorts {
		t.Run(p.Name(), func(t *testing.T) {
			if v := AssertTenantScoped(p, PortException[p.Name()]...); len(v) != 0 {
				t.Fatalf("un-scoped port method(s): %v", v)
			}
		})
	}
}

// TestPortExceptionsAreReal guards against a stale allow-list: every method named
// in PortException must reference a registered port and an actual method on it. A
// typo would silently weaken the fitness check.
func TestPortExceptionsAreReal(t *testing.T) {
	byName := make(map[string]reflect.Type, len(AllPorts))
	for _, p := range AllPorts {
		byName[p.Name()] = p
	}
	for portName, methods := range PortException {
		iface, ok := byName[portName]
		if !ok {
			t.Errorf("PortException references unregistered port %q", portName)
			continue
		}
		for _, m := range methods {
			if _, ok := iface.MethodByName(m); !ok {
				t.Errorf("PortException[%q] names non-existent method %q", portName, m)
			}
		}
	}
}

// TestAssertTenantScopedCatchesViolation proves the fitness function actually
// fails when a method is NOT tenant-scoped — otherwise it would be a no-op guard.
func TestAssertTenantScopedCatchesViolation(t *testing.T) {
	type Leaky interface {
		ReadAll(ctx context.Context) ([]LogEvent, error) // missing TenantContext
	}
	v := AssertTenantScoped(reflect.TypeFor[Leaky]())
	if len(v) != 1 {
		t.Fatalf("expected exactly 1 violation, got %v", v)
	}
}

// TestAssertTenantScopedHonoursAllowList confirms named exceptions are skipped.
func TestAssertTenantScopedHonoursAllowList(t *testing.T) {
	if v := AssertTenantScoped(reflect.TypeFor[Authenticator]()); len(v) == 0 {
		t.Fatal("Authenticate should be a violation without the allow list")
	}
	if v := AssertTenantScoped(reflect.TypeFor[Authenticator](), "Authenticate"); len(v) != 0 {
		t.Fatalf("allow list ignored: %v", v)
	}
}

func TestAssertTenantScopedRejectsNonInterface(t *testing.T) {
	if v := AssertTenantScoped(reflect.TypeFor[LogEvent]()); len(v) != 1 {
		t.Fatalf("expected non-interface to report a violation, got %v", v)
	}
}
