import { type LogLevel, logLevelSchema } from '@logalot/contracts';
import { z } from 'zod';

// ── Live-tail SSE frame contract ────────────────────────────────────────────
//
// The query-service streams `kernel.LogEvent` (pkg/kernel/event.go) over SSE as
// `data: {json}\n\n` data frames, plus `event: gap\ndata: {"dropped":N}\n\n` when a
// slow consumer is shed, and `: keepalive\n\n` comment heartbeats (which the
// browser's EventSource swallows). The BFF (`/api/tail`) pipes those frames back
// unchanged; this module is where the BROWSER parses them.
//
// There is deliberately NO shared `@logalot/contracts` schema for the streamed log
// event yet: `@logalot/contracts` covers the control-plane DTOs (auth/tenants/
// alert-rules/…), not the kernel's published log record. So we pin the wire shape
// HERE, mirroring the Go `json` tags exactly (snake_case). The `level` enum is the
// one field we DO reuse from contracts (`logLevelSchema`) so severity can never
// drift between the badge palette and the stream.
//
// NOTE for #22 (historical search): when search starts returning the same log
// record over its REST surface, lift `tailLogEventSchema` into `@logalot/contracts`
// as the canonical log-event DTO and have both the tail frame and the search
// response compose from it. The shape is intentionally identical to that future
// contract so the move is mechanical.

/**
 * One streamed log record. Field names mirror `kernel.LogEvent`'s json tags. Only
 * the fields the UI renders are typed; unknown keys (e.g. `raw`) are dropped rather
 * than failing the parse, so a backend adding a field never breaks the live tail.
 */
export const tailLogEventSchema = z.object({
  tenant_id: z.string(),
  // RFC3339 timestamp; kept as a string (display-only — we never do tz math here).
  ts: z.string(),
  id: z.string().optional(),
  service: z.string(),
  level: logLevelSchema,
  message: z.string(),
  // Go marshals a nil label map as JSON `null`; normalise both null and absent to
  // an empty object so consumers can treat `labels` as always-present.
  labels: z
    .record(z.string(), z.string())
    .nullish()
    .transform((v) => v ?? {}),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
});
export type TailLogEvent = z.infer<typeof tailLogEventSchema>;

/** Payload of an `event: gap` frame — how many events were dropped for this consumer. */
export const gapFrameSchema = z.object({ dropped: z.number().int().nonnegative() });
export type GapFrame = z.infer<typeof gapFrameSchema>;

export const LOG_LEVELS: readonly LogLevel[] = logLevelSchema.options;

/**
 * Parse a `data:` frame body into a log event, or null on malformed JSON / shape
 * drift. The tail must never throw on one bad frame — a single corrupt line is
 * dropped, the stream continues.
 */
export function parseLogFrame(data: string): TailLogEvent | null {
  try {
    return tailLogEventSchema.parse(JSON.parse(data));
  } catch {
    return null;
  }
}

/**
 * Parse a `gap` frame body into its dropped count. Returns 0 (no-op) on malformed
 * input so a corrupt gap line can never crash the stream or fabricate a huge gap.
 */
export function parseGapFrame(data: string): number {
  try {
    return gapFrameSchema.parse(JSON.parse(data)).dropped;
  } catch {
    return 0;
  }
}
