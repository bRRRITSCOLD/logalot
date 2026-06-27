package kernel

import (
	"fmt"
	"reflect"
)

// tenantContextType is resolved once for the reflective fitness check.
var tenantContextType = reflect.TypeFor[TenantContext]()

// AssertTenantScoped is the contract/fitness function that enforces the
// no-un-scoped-access rule (ADR-0002, overview.md §6): every method of a port
// interface must take TenantContext as its FIRST parameter. It returns a list of
// human-readable violations; an empty slice means the port is correctly scoped.
//
// iface must be the reflect.Type of an interface, obtained via
// reflect.TypeFor[LogStore](). allow lists method names that are sanctioned
// exceptions (the chicken-and-egg boundaries from model.md §4.5, e.g.
// "Authenticate"); listing a name skips the first-parameter check for it.
//
// Services compose this into their own contract tests so the invariant is a
// fitness function across the whole codebase, not a hope.
func AssertTenantScoped(iface reflect.Type, allow ...string) []string {
	var violations []string
	if iface == nil || iface.Kind() != reflect.Interface {
		return []string{fmt.Sprintf("AssertTenantScoped: %v is not an interface type", iface)}
	}

	allowed := make(map[string]struct{}, len(allow))
	for _, name := range allow {
		allowed[name] = struct{}{}
	}

	for i := 0; i < iface.NumMethod(); i++ {
		m := iface.Method(i)
		if _, ok := allowed[m.Name]; ok {
			continue
		}
		// For an interface method, m.Type has no receiver, so In(0) is the first
		// real parameter.
		if m.Type.NumIn() == 0 || m.Type.In(0) != tenantContextType {
			violations = append(violations, fmt.Sprintf(
				"%s.%s: first parameter must be kernel.TenantContext", iface.Name(), m.Name))
		}
	}
	return violations
}
