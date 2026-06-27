// Package broker is the shared RabbitMQ adapter implementing kernel.Broker. It is
// the single source of the ingest pipeline topology and publish/consume semantics
// (ADR-0004), reused by ingest-service (#6, publish side) and processor (#7,
// consume side) so the exchange/queue/DLX/DLQ contract lives in exactly one place
// (DRY).
//
// Durability contract (ADR-0004, overview.md §5.1):
//   - the exchange and queues are declared durable;
//   - messages are published persistent (DeliveryMode=2);
//   - the publisher channel runs in confirm mode, so Publish returns nil ONLY
//     after RabbitMQ has acked the durable enqueue. A nack or a context timeout
//     surfaces as an error — never a silent success — so the caller can never
//     return a false 202.
//
// Topology: a durable direct exchange routes to a durable work queue; the work
// queue dead-letters (on consumer nack-without-requeue) to a separate DLX which
// fans to a durable DLQ for poison-message capture and operator inspection.
package broker
