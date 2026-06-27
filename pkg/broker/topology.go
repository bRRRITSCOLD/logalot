package broker

import (
	"fmt"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Topology names every durable AMQP object the ingest pipeline relies on. It is a
// value type so a test (or a future per-environment override) can vary the names
// without touching the declare logic. The defaults below are the production
// contract (ADR-0004).
type Topology struct {
	// Exchange is the durable direct exchange ingest publishes to.
	Exchange string
	// Queue is the durable work queue the processor competes to consume.
	Queue string
	// RoutingKey binds Queue to Exchange (and DeadLetterQueue to DeadLetterExchange).
	RoutingKey string
	// DeadLetterExchange receives messages dead-lettered from Queue (consumer
	// nack without requeue) — the poison path.
	DeadLetterExchange string
	// DeadLetterQueue durably captures dead-lettered messages for inspection.
	DeadLetterQueue string
}

// DefaultTopology returns the production ingest topology names (ADR-0004). One
// source of truth shared by ingest (#6) and processor (#7).
func DefaultTopology() Topology {
	return Topology{
		Exchange:           "logalot.ingest",
		Queue:              "logalot.ingest.events",
		RoutingKey:         "ingest",
		DeadLetterExchange: "logalot.ingest.dlx",
		DeadLetterQueue:    "logalot.ingest.events.dlq",
	}
}

// declare idempotently declares the full topology on ch: the DLX/DLQ first, then
// the main exchange + queue wired to dead-letter into the DLX. All objects are
// durable so they survive a broker restart (the durability half of the
// no-acknowledged-loss guarantee). Re-declaring with identical arguments is a
// no-op, so every service may safely call it on boot.
func (t Topology) declare(ch *amqp.Channel) error {
	// Dead-letter side first so the main queue's x-dead-letter-exchange target
	// exists before it is referenced.
	if err := ch.ExchangeDeclare(t.DeadLetterExchange, amqp.ExchangeDirect, true, false, false, false, nil); err != nil {
		return fmt.Errorf("broker: declare dlx %q: %w", t.DeadLetterExchange, err)
	}
	if _, err := ch.QueueDeclare(t.DeadLetterQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("broker: declare dlq %q: %w", t.DeadLetterQueue, err)
	}
	if err := ch.QueueBind(t.DeadLetterQueue, t.RoutingKey, t.DeadLetterExchange, false, nil); err != nil {
		return fmt.Errorf("broker: bind dlq %q: %w", t.DeadLetterQueue, err)
	}

	// Main side. The work queue dead-letters into the DLX on consumer reject.
	if err := ch.ExchangeDeclare(t.Exchange, amqp.ExchangeDirect, true, false, false, false, nil); err != nil {
		return fmt.Errorf("broker: declare exchange %q: %w", t.Exchange, err)
	}
	args := amqp.Table{
		"x-dead-letter-exchange":    t.DeadLetterExchange,
		"x-dead-letter-routing-key": t.RoutingKey,
	}
	if _, err := ch.QueueDeclare(t.Queue, true, false, false, false, args); err != nil {
		return fmt.Errorf("broker: declare queue %q: %w", t.Queue, err)
	}
	if err := ch.QueueBind(t.Queue, t.RoutingKey, t.Exchange, false, nil); err != nil {
		return fmt.Errorf("broker: bind queue %q: %w", t.Queue, err)
	}
	return nil
}
