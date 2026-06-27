package tailbus

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/redis/go-redis/v9"
)

const (
	tenantA = kernel.TenantID("00000000-0000-0000-0000-00000000000a")
	tenantB = kernel.TenantID("00000000-0000-0000-0000-00000000000b")
)

// fakeRedis records publish calls and satisfies the client seam. Subscribe is
// unused in unit tests (round-trip is covered by the integration test) and panics
// if reached, keeping the test honest.
type fakeRedis struct {
	channel string
	payload string
	pubErr  error
	calls   int
}

func (f *fakeRedis) Publish(_ context.Context, channel string, message any) *redis.IntCmd {
	f.calls++
	f.channel = channel
	if s, ok := message.([]byte); ok {
		f.payload = string(s)
	}
	cmd := redis.NewIntCmd(context.Background())
	if f.pubErr != nil {
		cmd.SetErr(f.pubErr)
	} else {
		cmd.SetVal(1)
	}
	return cmd
}

func (f *fakeRedis) Subscribe(_ context.Context, _ ...string) *redis.PubSub {
	panic("Subscribe not used in unit tests")
}

func TestPublish_DerivesChannelFromContextAndStampsTenant(t *testing.T) {
	fr := &fakeRedis{}
	b := New(fr)
	tc := kernel.TenantContext{TenantID: tenantA}

	// The event carries a foreign tenant; it MUST be overwritten from tc and the
	// channel MUST be derived from tc, never the event.
	ev := kernel.LogEvent{TenantID: tenantB, Message: "hi", Level: kernel.LevelInfo}
	if err := b.Publish(tc, context.Background(), ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if fr.channel != "tail:"+string(tenantA) {
		t.Errorf("channel = %q, want tail:%s", fr.channel, tenantA)
	}
	var got kernel.LogEvent
	if err := json.Unmarshal([]byte(fr.payload), &got); err != nil {
		t.Fatalf("payload not valid LogEvent json: %v", err)
	}
	if got.TenantID != tenantA {
		t.Errorf("published tenant_id = %q, want %q (event tenant must be ignored)", got.TenantID, tenantA)
	}
}

func TestPublish_FailsClosedOnInvalidTenant(t *testing.T) {
	fr := &fakeRedis{}
	b := New(fr)
	err := b.Publish(kernel.TenantContext{TenantID: ""}, context.Background(), kernel.LogEvent{})
	if !errors.Is(err, kernel.ErrNoTenantContext) {
		t.Fatalf("err = %v, want ErrNoTenantContext", err)
	}
	if fr.calls != 0 {
		t.Error("must not PUBLISH for an invalid tenant")
	}
}

func TestPublish_SurfacesRedisError(t *testing.T) {
	boom := errors.New("redis down")
	fr := &fakeRedis{pubErr: boom}
	b := New(fr)
	err := b.Publish(kernel.TenantContext{TenantID: tenantA}, context.Background(), kernel.LogEvent{Level: kernel.LevelInfo})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want wrapped %v", err, boom)
	}
}

func TestSubscribe_FailsClosedOnInvalidTenant(t *testing.T) {
	fr := &fakeRedis{}
	b := New(fr)
	_, err := b.Subscribe(kernel.TenantContext{TenantID: "bad"}, context.Background())
	if !errors.Is(err, kernel.ErrInvalidTenantID) {
		t.Fatalf("err = %v, want ErrInvalidTenantID", err)
	}
}
