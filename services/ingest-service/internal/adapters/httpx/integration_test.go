//go:build integration

// End-to-end ingest integration test: a real Gin server over the real RabbitMQ
// broker adapter in a random-port testcontainer (the host runs a conflicting
// broker on 5672). Gated behind the `integration` tag:
//
//	go test -tags=integration ./...
//
// It proves what fakes cannot: a 202 is returned ONLY after the message is
// durably enqueued (it is read back off the durable queue), the enqueued tenant
// comes from the key not the body, and a broker-down request yields a 5xx (no
// false 202).
package httpx

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/app"
	amqp "github.com/rabbitmq/amqp091-go"
	tcrabbitmq "github.com/testcontainers/testcontainers-go/modules/rabbitmq"
)

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

func TestIntegration_202OnlyAfterDurableEnqueue(t *testing.T) {
	ctx := context.Background()
	url := startRabbit(t)

	b, err := broker.New(ctx, url)
	if err != nil {
		t.Fatalf("broker.New: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := app.New(b)
	h := NewHandler(svc, nil, log)
	srv := httptest.NewServer(NewRouter(h, stubAuth{tc: okTenant()}, RateLimit{}, log))
	t.Cleanup(srv.Close)

	body := `{"tenant_id":"` + string(foreignTenant) + `","message":"e2e","level":"warn"}`
	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), body)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status=%d, want 202", resp.StatusCode)
	}

	// The 202 must mean the message is really on the durable queue: read it back.
	got := getOne(t, url, b.Topology().Queue)
	if got.DeliveryMode != amqp.Persistent {
		t.Errorf("DeliveryMode=%d, want persistent", got.DeliveryMode)
	}
	var env kernel.Envelope
	if err := json.Unmarshal(got.Body, &env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if env.TenantID != keyTenant {
		t.Fatalf("enqueued tenant_id=%q, want the key's tenant %q (body must be ignored)", env.TenantID, keyTenant)
	}
}

func TestIntegration_5xxWhenBrokerDown(t *testing.T) {
	ctx := context.Background()
	url := startRabbit(t)

	b, err := broker.New(ctx, url)
	if err != nil {
		t.Fatalf("broker.New: %v", err)
	}
	// Take the broker down before serving traffic.
	if err := b.Close(); err != nil {
		t.Fatalf("close broker: %v", err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := app.New(b)
	h := NewHandler(svc, nil, log)
	srv := httptest.NewServer(NewRouter(h, stubAuth{tc: okTenant()}, RateLimit{}, log))
	t.Cleanup(srv.Close)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"message":"down"}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 500 || resp.StatusCode > 599 {
		t.Fatalf("status=%d, want 5xx when broker is down (no false 202)", resp.StatusCode)
	}
}

func getOne(t *testing.T, url, queue string) amqp.Delivery {
	t.Helper()
	conn, err := amqp.Dial(url)
	if err != nil {
		t.Fatalf("dial verify: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	ch, err := conn.Channel()
	if err != nil {
		t.Fatalf("verify channel: %v", err)
	}
	t.Cleanup(func() { _ = ch.Close() })
	msg, ok, err := ch.Get(queue, true)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !ok {
		t.Fatal("no message on queue: 202 was returned without a durable enqueue")
	}
	return msg
}
