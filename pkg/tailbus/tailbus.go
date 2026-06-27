package tailbus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/redis/go-redis/v9"
)

// publisher is the minimal Redis publish seam the adapter needs, satisfied by
// *redis.Client. It lets unit tests assert the exact channel/payload without a
// live Redis.
type publisher interface {
	Publish(ctx context.Context, channel string, message any) *redis.IntCmd
}

// subscriber is the minimal Redis subscribe seam, satisfied by *redis.Client.
type subscriber interface {
	Subscribe(ctx context.Context, channels ...string) *redis.PubSub
}

// client is the union the adapter holds; *redis.Client satisfies both halves.
type client interface {
	publisher
	subscriber
}

// Bus is the Redis-backed kernel.TailBus.
type Bus struct {
	rc  client
	log *slog.Logger
}

// compile-time proof the adapter satisfies the kernel port.
var _ kernel.TailBus = (*Bus)(nil)

// Option configures a Bus.
type Option func(*Bus)

// WithLogger sets the structured logger (defaults to a discard logger).
func WithLogger(l *slog.Logger) Option { return func(b *Bus) { b.log = l } }

// New builds a Bus over a Redis client.
func New(rc client, opts ...Option) *Bus {
	b := &Bus{rc: rc, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, o := range opts {
		o(b)
	}
	if b.log == nil {
		b.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return b
}

// Publish fans event out on the tenant's tail channel. The channel is derived
// from tc (fail-closed on a blank/invalid tenant); the event's tenant_id is
// stamped from tc before encoding so the published JSON can never carry a foreign
// tenant (ADR-0002). The payload is the stable kernel.LogEvent JSON shape.
func (b *Bus) Publish(tc kernel.TenantContext, ctx context.Context, event kernel.LogEvent) error {
	channel, err := kernel.TailChannel(tc)
	if err != nil {
		return err
	}
	event.TenantID = tc.TenantID
	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("tailbus: marshal event: %w", err)
	}
	if err := b.rc.Publish(ctx, channel, payload).Err(); err != nil {
		return fmt.Errorf("tailbus: publish %s: %w", channel, err)
	}
	return nil
}

// Subscribe streams the tenant's tail channel until ctx is cancelled. The channel
// is derived from tc (fail-closed). Messages that fail to decode are logged and
// skipped rather than killing the stream. The returned channel is closed when ctx
// ends or the subscription drops; the underlying PubSub is closed then too.
func (b *Bus) Subscribe(tc kernel.TenantContext, ctx context.Context) (<-chan kernel.LogEvent, error) {
	channel, err := kernel.TailChannel(tc)
	if err != nil {
		return nil, err
	}
	sub := b.rc.Subscribe(ctx, channel)
	msgs := sub.Channel()
	out := make(chan kernel.LogEvent)

	go func() {
		defer close(out)
		defer func() { _ = sub.Close() }()
		for {
			select {
			case <-ctx.Done():
				return
			case m, ok := <-msgs:
				if !ok {
					return
				}
				var ev kernel.LogEvent
				if derr := json.Unmarshal([]byte(m.Payload), &ev); derr != nil {
					b.log.WarnContext(ctx, "tailbus: undecodable tail message; skipping", "channel", channel, "err", derr)
					continue
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}
