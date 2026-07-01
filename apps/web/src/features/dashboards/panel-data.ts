import { z } from 'zod';
import { tailLogEventSchema } from '../log-explorer/tail-event';
import { toRfc3339 } from '../log-search/search-query';

// ── Panel-data domain model + wire mapping (issue #192) ──────────────────────
//
// query-service GET /v1/panel-data returns a panel's aggregation over its saved
// query: a total match count, a SPARSE bucketed time-series (buckets with zero
// matches are OMITTED by the handler — see panel.go), and a sample of recent
// matching events (the same `kernel.LogEvent` shape the tail/search surfaces
// already parse). This module owns:
//   • panelDataResponseSchema — the response contract, composed from the shared
//     `tailLogEventSchema` so severity/field shape can never drift across
//     tail/search/panel surfaces;
//   • buildPanelDataParams — the SINGLE source of truth mapping panel-request
//     params onto the handler's querystring (savedQueryId/from/to/buckets),
//     consumed by both the BFF (server/panel-data.ts) and its tests;
//   • gapFillBuckets — densifies the sparse bucket series into a continuous,
//     zero-filled, time-monotonic series for charting (the handler's doc comment
//     explicitly delegates this to the caller).

/** One time-series data point as returned by the handler (or produced by gap-fill). */
export interface PanelBucket {
  /** RFC3339 bucket start. */
  bucketStart: string;
  count: number;
}

/**
 * GET /v1/panel-data response: a total count, a sparse bucketed time-series, and
 * a sample of recent matching events. Composed from the shared log-event schema.
 */
export const panelDataResponseSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  buckets: z.array(
    z.object({
      bucketStart: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  recentLogs: z.array(tailLogEventSchema),
});
export type PanelDataResult = z.infer<typeof panelDataResponseSchema>;

/**
 * The result of loading a panel's data, as surfaced to the UI. A failure carries
 * a user-safe message (validation text for a 400, "panel query not found" for a
 * 404, a generic message otherwise); the no-session path is handled upstream by
 * a redirect, never reaching here.
 */
export type PanelDataOutcome = { ok: true; data: PanelDataResult } | { ok: false; message: string };

/** Ceiling on the requested bucket count, mirroring the handler's own clamp. */
export const MAX_PANEL_BUCKETS = 100;

/** Clamp a caller-supplied bucket count to `1..MAX_PANEL_BUCKETS`. Non-finite/≤0 falls back to 1. */
function clampBuckets(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(MAX_PANEL_BUCKETS, Math.round(n));
}

/** Input to `buildPanelDataParams` — only `savedQueryId` is required (the handler defaults the rest). */
export interface PanelDataParamsInput {
  savedQueryId: string;
  /** Range start; RFC3339 or a datetime-local value (normalized on the wire). */
  from?: string;
  /** Range end (normalized on the wire). */
  to?: string;
  /** Requested bucket count; clamped to `1..MAX_PANEL_BUCKETS` (server default: 30). */
  buckets?: number;
}

/**
 * Map panel-request params onto the query-service `/v1/panel-data` querystring.
 * `from`/`to` are normalized to RFC3339 (mirrors `buildSearchParams`'s `toRfc3339`
 * use); `buckets` is clamped so a caller can never request more than the handler
 * allows. This is the only place the panel-data request contract is encoded.
 */
export function buildPanelDataParams(input: PanelDataParamsInput): URLSearchParams {
  const p = new URLSearchParams();
  p.set('savedQueryId', input.savedQueryId);

  if (input.from !== undefined) {
    const from = toRfc3339(input.from);
    if (from !== '') p.set('from', from);
  }
  if (input.to !== undefined) {
    const to = toRfc3339(input.to);
    if (to !== '') p.set('to', to);
  }
  if (typeof input.buckets === 'number') {
    p.set('buckets', String(clampBuckets(input.buckets)));
  }

  return p;
}

/**
 * Densify a SPARSE bucket series (the handler omits zero-count buckets) into a
 * continuous, zero-filled, time-monotonic series of `n` buckets spanning
 * `[from, to)` — the exact contract the handler's doc comment asks callers to
 * uphold. Any bucket falling outside `[from, to)`, or an invalid range/`n`,
 * yields an empty (`[]`) series rather than throwing.
 */
export function gapFillBuckets(
  buckets: readonly PanelBucket[],
  from: string,
  to: string,
  n: number,
): PanelBucket[] {
  if (n <= 0) return [];

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  const size = (toMs - fromMs) / n;

  // Sparse input, sorted ascending so a single forward cursor can bucket it in
  // one linear pass alongside the generated dense slots.
  const sorted = buckets
    .map((b) => ({ ms: Date.parse(b.bucketStart), count: b.count }))
    .filter((b) => Number.isFinite(b.ms))
    .sort((a, b) => a.ms - b.ms);

  let cursor = 0;
  const dense: PanelBucket[] = [];
  for (let i = 0; i < n; i++) {
    const slotStart = fromMs + i * size;
    const slotEnd = slotStart + size;
    let count = 0;
    let next = sorted[cursor];
    while (next !== undefined && next.ms < slotEnd) {
      if (next.ms >= slotStart) count += next.count;
      cursor++;
      next = sorted[cursor];
    }
    dense.push({ bucketStart: new Date(slotStart).toISOString(), count });
  }
  return dense;
}
