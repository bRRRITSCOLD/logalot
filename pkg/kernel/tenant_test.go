package kernel

import (
	"context"
	"errors"
	"testing"
)

const testTenantID = "11111111-1111-1111-1111-111111111111"

func sampleTC() TenantContext {
	return TenantContext{
		TenantID:    testTenantID,
		PrincipalID: "user-1",
		Role:        RoleMember,
		Scopes:      []Scope{ScopeIngestWrite},
	}
}

func TestTenantContextRoundTripThroughContext(t *testing.T) {
	want := sampleTC()
	ctx := WithTenant(context.Background(), want)

	got, ok := FromContext(ctx)
	if !ok {
		t.Fatal("FromContext: ok = false, want true")
	}
	if got.TenantID != want.TenantID || got.PrincipalID != want.PrincipalID || got.Role != want.Role {
		t.Fatalf("round-trip mismatch: got %+v, want %+v", got, want)
	}
	if len(got.Scopes) != 1 || got.Scopes[0] != ScopeIngestWrite {
		t.Fatalf("scopes lost in round-trip: %+v", got.Scopes)
	}
}

func TestFromContextMissingFailsClosed(t *testing.T) {
	if _, ok := FromContext(context.Background()); ok {
		t.Fatal("FromContext on bare context: ok = true, want false (fail closed)")
	}
}

func TestMustFromContextPanicsWhenAbsent(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("MustFromContext did not panic on missing tenant")
		}
		if err, ok := r.(error); !ok || !errors.Is(err, ErrNoTenantContext) {
			t.Fatalf("panic value = %v, want ErrNoTenantContext", r)
		}
	}()
	MustFromContext(context.Background())
}

func TestTenantContextValid(t *testing.T) {
	tests := []struct {
		name    string
		tc      TenantContext
		wantErr error
	}{
		{"valid", sampleTC(), nil},
		{"blank", TenantContext{TenantID: ""}, ErrNoTenantContext},
		{"whitespace", TenantContext{TenantID: "   "}, ErrNoTenantContext},
		{"not a uuid", TenantContext{TenantID: "tenant-a"}, ErrInvalidTenantID},
		{"truncated uuid", TenantContext{TenantID: "1111-1111"}, ErrInvalidTenantID},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.tc.Valid()
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Valid() = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestTenantContextHasScopeAndRole(t *testing.T) {
	tc := sampleTC()
	if !tc.HasScope(ScopeIngestWrite) {
		t.Error("HasScope(ingest:write) = false, want true")
	}
	if tc.HasScope("admin:all") {
		t.Error("HasScope(admin:all) = true, want false")
	}
	if !tc.HasRole(RoleMember) {
		t.Error("HasRole(member) = false, want true")
	}
	if tc.HasRole(RolePlatformOperator) {
		t.Error("HasRole(platform_operator) = true, want false")
	}
}

func TestRoleValid(t *testing.T) {
	for _, r := range []Role{RoleTenantAdmin, RoleMember, RolePlatformOperator} {
		if !r.Valid() {
			t.Errorf("Role(%q).Valid() = false, want true", r)
		}
	}
	if Role("root").Valid() {
		t.Error("Role(root).Valid() = true, want false")
	}
}
