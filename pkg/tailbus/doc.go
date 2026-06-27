// Package tailbus is the Redis pub/sub adapter for the kernel.TailBus port
// (ADR-0006). It is a shared module: the processor (#7) PUBLISHes each persisted
// event to the live-tail bus, and the query-service (#8) SUBSCRIBEs to stream it
// to SSE clients, so the channel-naming isolation rule lives in one place (DRY).
//
// The channel is ALWAYS tail:{tenant_id}, derived from the TenantContext via
// kernel.TailChannel — never from user input or the event body. A blank/invalid
// tenant fails closed (no channel is produced, nothing is published/subscribed).
//
// Tail is best-effort and lossy by design (ADR-0006): a publish that cannot reach
// Redis is reported to the caller, which logs and moves on rather than endangering
// the durable persist path. There is no replay; a missed window is served by
// search.
package tailbus
