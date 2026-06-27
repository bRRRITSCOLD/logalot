//go:build integration

// Broker integration tests run against a real RabbitMQ in a random-port
// testcontainer (the host runs a conflicting broker on 5672, so fixed ports are
// avoided). Gated behind the `integration` build tag so default `go test ./...`
// stays Docker-free:
//
//	go test -tags=integration ./...
//
// They prove the load-bearing durability contract a fake cannot: a confirmed
// publish actually lands a persistent message on the durable queue, and a publish
// against a down broker fails rather than silently "succeeding".
package broker

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	amqp "github.com/rabbitmq/amqp091-go"
	tcrabbitmq "github.com/testcontainers/testcontainers-go/modules/rabbitmq"
)

const tenantA = kernel.TenantID("00000000-0000-0000-0000-00000000000a")

func startRabbit(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	c, err := tcrabbitmq.Run(ctx, "rabbitmq:3-management-alpine")
	if err != nil {
		t.Fatalf("start rabbitmq: %v", err)
	}
	t.Cleanup(func() { _ = c.Terminate(ctx) })
	url, err := c.AmqpURL(ctx)
	if err != nil {
		t.Fatalf("amqp url: %v", err)
	}
	return url
}

func TestIntegration_PublishConfirmsAndIsDurablyEnqueued(t *testing.T) {
	ctx := context.Background()
	url := startRabbit(t)

	b, err := New(ctx, url)
	if err != nil {
		t.Fatalf("New broker: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	tc := kernel.TenantContext{TenantID: tenantA, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
	raw := json.RawMessage(`{"message":"hello","level":"info"}`)
	env := kernel.Envelope{TenantID: tenantA, ReceivedAt: time.Now().UTC(), Raw: raw}

	if err := b.Publish(tc, ctx, env); err != nil {
		t.Fatalf("Publish (should be confirmed): %v", err)
	}

	// Read the message back off the DURABLE queue with a raw channel Get. If it is
	// really enqueued (and the publish was truly confirmed), it is sitting here.
	conn, err := amqp.Dial(url)
	if err != nil {
		t.Fatalf("dial for verify: %v", err)
	}
	defer func() { _ = conn.Close() }()
	ch, err := conn.Channel()
	if err != nil {
		t.Fatalf("verify channel: %v", err)
	}
	defer func() { _ = ch.Close() }()

	// Confirm the queue is durable by passive-declaring it with durable=true; a
	// mismatch would error.
	if _, err := ch.QueueDeclarePassive(b.Topology().Queue, true, false, false, false, nil); err != nil {
		t.Fatalf("queue is not durable as declared: %v", err)
	}

	msg, ok, err := ch.Get(b.Topology().Queue, true)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !ok {
		t.Fatal("no message on the queue: confirmed publish did not durably enqueue")
	}
	if msg.DeliveryMode != amqp.Persistent {
		t.Errorf("message DeliveryMode=%d, want persistent(2)", msg.DeliveryMode)
	}
	var got kernel.Envelope
	if err := json.Unmarshal(msg.Body, &got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if got.TenantID != tenantA {
		t.Errorf("enqueued tenant_id=%q, want %q", got.TenantID, tenantA)
	}
}

func TestIntegration_ConsumeRoundTrip(t *testing.T) {
	ctx := context.Background()
	url := startRabbit(t)

	b, err := New(ctx, url)
	if err != nil {
		t.Fatalf("New broker: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	tc := kernel.TenantContext{TenantID: tenantA, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
	env := kernel.Envelope{TenantID: tenantA, ReceivedAt: time.Now().UTC(), Raw: json.RawMessage(`{"message":"rt"}`)}
	if err := b.Publish(tc, ctx, env); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	got := make(chan kernel.Envelope, 1)
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		_ = b.Consume(kernel.TenantContext{TenantID: tenantA}, cctx, func(mtc kernel.TenantContext, _ context.Context, e kernel.Envelope) error {
			// The handler must receive a tenant scope rebuilt from the envelope.
			if mtc.TenantID != e.TenantID {
				t.Errorf("handler tc.TenantID=%q != envelope tenant %q", mtc.TenantID, e.TenantID)
			}
			got <- e
			return nil
		})
	}()

	select {
	case e := <-got:
		if e.TenantID != tenantA {
			t.Errorf("consumed tenant_id=%q, want %q", e.TenantID, tenantA)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting to consume the published message")
	}
}

func TestIntegration_PublishFailsWhenBrokerDown(t *testing.T) {
	ctx := context.Background()
	url := startRabbit(t)

	b, err := New(ctx, url)
	if err != nil {
		t.Fatalf("New broker: %v", err)
	}

	// Simulate broker-down by closing the connection out from under the broker.
	if err := b.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	tc := kernel.TenantContext{TenantID: tenantA, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
	env := kernel.Envelope{TenantID: tenantA, ReceivedAt: time.Now().UTC(), Raw: json.RawMessage(`{"m":1}`)}
	if err := b.Publish(tc, ctx, env); err == nil {
		t.Fatal("Publish must fail when the broker connection is down (no false success)")
	}
}
