package kernel

import (
	"context"
	"errors"
	"testing"
)

// recordingExec captures the last statement + args an ExecFunc was called with.
type recordingExec struct {
	called bool
	sql    string
	args   []any
}

func (r *recordingExec) fn() ExecFunc {
	return func(_ context.Context, sql string, args ...any) error {
		r.called = true
		r.sql = sql
		r.args = args
		return nil
	}
}

func TestArmTenantEmitsParameterizedSetLocal(t *testing.T) {
	rec := &recordingExec{}
	if err := ArmTenant(sampleTC(), context.Background(), rec.fn()); err != nil {
		t.Fatal(err)
	}
	if !rec.called {
		t.Fatal("ArmTenant did not execute any statement")
	}
	if rec.sql != `SELECT set_config('app.tenant_id', $1, true)` {
		t.Fatalf("emitted sql = %q", rec.sql)
	}
	if len(rec.args) != 1 || rec.args[0] != testTenantID {
		t.Fatalf("emitted args = %v, want [%s]", rec.args, testTenantID)
	}
}

func TestArmTenantFailsClosedOnNoTenant(t *testing.T) {
	rec := &recordingExec{}
	err := ArmTenant(TenantContext{TenantID: ""}, context.Background(), rec.fn())
	if !errors.Is(err, ErrNoTenantContext) {
		t.Fatalf("err = %v, want ErrNoTenantContext", err)
	}
	if rec.called {
		t.Fatal("ArmTenant executed a statement for a blank tenant; must fail closed")
	}
}

func TestArmTenantFailsClosedOnInvalidTenant(t *testing.T) {
	rec := &recordingExec{}
	err := ArmTenant(TenantContext{TenantID: "not-a-uuid"}, context.Background(), rec.fn())
	if !errors.Is(err, ErrInvalidTenantID) {
		t.Fatalf("err = %v, want ErrInvalidTenantID", err)
	}
	if rec.called {
		t.Fatal("ArmTenant executed for an invalid tenant; must fail closed")
	}
}

func TestWithTenantScopeArmsBeforeWork(t *testing.T) {
	rec := &recordingExec{}
	workRan := false
	err := WithTenantScope(sampleTC(), context.Background(), rec.fn(), func() error {
		if !rec.called {
			t.Fatal("work ran before RLS was armed")
		}
		workRan = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !workRan {
		t.Fatal("work did not run")
	}
}

func TestWithTenantScopeSkipsWorkWhenUnscoped(t *testing.T) {
	rec := &recordingExec{}
	workRan := false
	err := WithTenantScope(TenantContext{}, context.Background(), rec.fn(), func() error {
		workRan = true
		return nil
	})
	if !errors.Is(err, ErrNoTenantContext) {
		t.Fatalf("err = %v, want ErrNoTenantContext", err)
	}
	if workRan {
		t.Fatal("work ran without a tenant scope; must fail closed")
	}
}

func TestLiteralSetLocal(t *testing.T) {
	got, err := LiteralSetLocal(sampleTC())
	if err != nil {
		t.Fatal(err)
	}
	want := "SET LOCAL app.tenant_id = '" + testTenantID + "'"
	if got != want {
		t.Fatalf("LiteralSetLocal = %q, want %q", got, want)
	}
	if _, err := LiteralSetLocal(TenantContext{}); !errors.Is(err, ErrNoTenantContext) {
		t.Fatalf("blank tenant err = %v, want ErrNoTenantContext", err)
	}
}

func TestTenantGUCName(t *testing.T) {
	if TenantGUC != "app.tenant_id" {
		t.Fatalf("TenantGUC = %q, want app.tenant_id (authoritative convention)", TenantGUC)
	}
}
