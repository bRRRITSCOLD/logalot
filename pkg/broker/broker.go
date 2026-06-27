package broker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	amqp "github.com/rabbitmq/amqp091-go"
)

// ErrNotConfirmed is returned when RabbitMQ explicitly NACKs a publish (the
// durable enqueue did not happen). The caller MUST treat it as a failed publish
// and never return a 202.
var ErrNotConfirmed = errors.New("broker: publish nacked by rabbitmq (not durably enqueued)")

// ErrClosed is returned when the underlying connection is closed.
var ErrClosed = errors.New("broker: connection is closed")

// Broker is the RabbitMQ implementation of kernel.Broker. A single connection is
// multiplexed over a small free-list of confirm-mode channels for publishing
// (AMQP channels are not safe for concurrent use, so each in-flight Publish owns
// one). Consume opens its own dedicated channel.
type Broker struct {
	conn     *amqp.Connection
	topo     Topology
	log      *slog.Logger
	now      func() time.Time
	prefetch int

	mu   sync.Mutex
	pool []*amqp.Channel // free-list of confirm-mode publisher channels
	cap  int
}

// compile-time proof the adapter satisfies the kernel port.
var _ kernel.Broker = (*Broker)(nil)

// New dials url, optionally declares the topology, and returns a ready Broker. The
// caller owns it and MUST Close it. By default the topology is declared on boot
// (idempotent), so both ingest and processor converge on the same objects.
func New(_ context.Context, url string, opts ...Option) (*Broker, error) {
	cfg := resolveConfig(opts...)
	conn, err := amqp.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("broker: dial: %w", err)
	}
	b := &Broker{
		conn:     conn,
		topo:     cfg.topo,
		log:      cfg.log,
		now:      cfg.now,
		prefetch: cfg.prefetch,
		cap:      cfg.poolSize,
	}
	if cfg.declare {
		if err := b.DeclareTopology(context.Background()); err != nil {
			_ = conn.Close()
			return nil, err
		}
	}
	return b, nil
}

// Topology returns the names this broker publishes/consumes against, so callers
// (e.g. tests, processor wiring) can reference them without re-deriving.
func (b *Broker) Topology() Topology { return b.topo }

// DeclareTopology (re)declares the durable exchange/queue/DLX/DLQ. Idempotent.
func (b *Broker) DeclareTopology(_ context.Context) error {
	ch, err := b.conn.Channel()
	if err != nil {
		return fmt.Errorf("broker: open declare channel: %w", err)
	}
	defer func() { _ = ch.Close() }()
	return b.topo.declare(ch)
}

// Publish enqueues env durably and returns nil ONLY after a publisher confirm
// (broker ack). The authoritative tenant is taken from tc, never from any
// TenantID a caller may have placed on env (ADR-0002) — it is overwritten
// defensively here so the storage-layer contract cannot be bypassed.
func (b *Broker) Publish(tc kernel.TenantContext, ctx context.Context, env kernel.Envelope) error {
	if err := tc.Valid(); err != nil {
		return err
	}
	env.TenantID = tc.TenantID
	if env.ReceivedAt.IsZero() {
		env.ReceivedAt = b.now().UTC()
	}
	body, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("broker: marshal envelope: %w", err)
	}

	ch, err := b.acquire()
	if err != nil {
		return err
	}
	dc, err := ch.PublishWithDeferredConfirmWithContext(ctx, b.topo.Exchange, b.topo.RoutingKey, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    env.ReceivedAt,
		Body:         body,
	})
	if err != nil {
		_ = ch.Close() // poisoned channel; do not return it to the pool
		return fmt.Errorf("broker: publish: %w", err)
	}

	select {
	case <-dc.Done():
		if !dc.Acked() {
			b.release(ch)
			return ErrNotConfirmed
		}
		b.release(ch)
		return nil
	case <-ctx.Done():
		// Confirm did not arrive in time: the enqueue is unconfirmed, so we MUST
		// surface an error (never a false success). The channel state is now
		// ambiguous, so discard it.
		_ = ch.Close()
		return fmt.Errorf("broker: confirm wait: %w", ctx.Err())
	}
}

// Consume drains the durable work queue with manual ack and bounded prefetch. For
// each delivery it rebuilds a fresh per-message TenantContext from the envelope's
// authoritative tenant_id (kernel ports.go: the consuming identity is NOT the
// message tenant) and invokes handler under THAT scope. Handler success acks;
// handler failure or an unparseable body nacks without requeue, routing the
// message to the DLX → DLQ. Blocks until ctx is cancelled or the channel closes.
func (b *Broker) Consume(tc kernel.TenantContext, ctx context.Context, handler kernel.EnvelopeHandler) error {
	ch, err := b.conn.Channel()
	if err != nil {
		return fmt.Errorf("broker: open consume channel: %w", err)
	}
	defer func() { _ = ch.Close() }()

	if err := ch.Qos(b.prefetch, 0, false); err != nil {
		return fmt.Errorf("broker: qos: %w", err)
	}
	deliveries, err := ch.Consume(b.topo.Queue, "", false /*autoAck*/, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("broker: consume %q: %w", b.topo.Queue, err)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case d, ok := <-deliveries:
			if !ok {
				return ErrClosed
			}
			b.handleDelivery(ctx, d, handler)
		}
	}
}

func (b *Broker) handleDelivery(ctx context.Context, d amqp.Delivery, handler kernel.EnvelopeHandler) {
	var env kernel.Envelope
	if err := json.Unmarshal(d.Body, &env); err != nil {
		b.log.WarnContext(ctx, "broker: undecodable delivery -> dlq", "err", err)
		_ = d.Nack(false, false)
		return
	}
	// Authoritative per-message scope from the envelope, re-validated fail-closed.
	mtc := kernel.TenantContext{TenantID: env.TenantID, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
	if err := mtc.Valid(); err != nil {
		b.log.WarnContext(ctx, "broker: delivery with invalid tenant -> dlq", "err", err)
		_ = d.Nack(false, false)
		return
	}
	if err := handler(mtc, ctx, env); err != nil {
		b.log.WarnContext(ctx, "broker: handler failed -> dlq", "err", err)
		_ = d.Nack(false, false)
		return
	}
	_ = d.Ack(false)
}

// Check reports broker reachability for readiness probes. Cheap: it inspects the
// connection rather than round-tripping the broker on every probe.
func (b *Broker) Check(_ context.Context) error {
	if b.conn == nil || b.conn.IsClosed() {
		return ErrClosed
	}
	return nil
}

// Close tears down pooled channels and the connection.
func (b *Broker) Close() error {
	b.mu.Lock()
	for _, ch := range b.pool {
		_ = ch.Close()
	}
	b.pool = nil
	b.mu.Unlock()
	if b.conn != nil && !b.conn.IsClosed() {
		return b.conn.Close()
	}
	return nil
}

// acquire returns a confirm-mode channel from the pool or opens a fresh one.
func (b *Broker) acquire() (*amqp.Channel, error) {
	b.mu.Lock()
	for len(b.pool) > 0 {
		n := len(b.pool) - 1
		ch := b.pool[n]
		b.pool = b.pool[:n]
		if !ch.IsClosed() {
			b.mu.Unlock()
			return ch, nil
		}
		// drop the dead channel and try the next pooled one
	}
	b.mu.Unlock()

	if b.conn == nil || b.conn.IsClosed() {
		return nil, ErrClosed
	}
	ch, err := b.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("broker: open publish channel: %w", err)
	}
	if err := ch.Confirm(false); err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("broker: enable confirms: %w", err)
	}
	return ch, nil
}

// release returns a healthy channel to the pool, or closes it if the pool is full
// or the channel is dead.
func (b *Broker) release(ch *amqp.Channel) {
	if ch.IsClosed() {
		return
	}
	b.mu.Lock()
	if len(b.pool) < b.cap {
		b.pool = append(b.pool, ch)
		b.mu.Unlock()
		return
	}
	b.mu.Unlock()
	_ = ch.Close()
}
