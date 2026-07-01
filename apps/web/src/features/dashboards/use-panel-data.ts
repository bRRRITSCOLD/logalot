import * as React from 'react';
import { loadPanelDataFn } from '../../server/panel-data';
import { gapFillBuckets, type PanelBucket } from './panel-data';

// ── Per-panel data hook (issue #196) ──────────────────────────────────────────
//
// Each panel on a dashboard fetches its OWN data, independently of its siblings
// (a slow/failed panel must never block or crash the rest of the grid — see
// `PanelGrid`). This hook owns that per-panel lifecycle: it calls `loadPanelDataFn`
// (the BFF relay, #201) keyed by `savedQueryId` + the active `{from, to}` range,
// gap-fills the returned sparse bucket series (`gapFillBuckets`, #201) into a
// dense, chartable one, and maps the outcome onto a small state machine the
// panel body (`TimeseriesChart` / `StatPanel`) renders directly.

/** Mirrors the shared viz-primitive state set (`PanelVizState`), minus `empty` —
 * callers derive `empty` from the resolved data (see `PanelGrid`). */
export type PanelDataState = 'loading' | 'default' | 'error';

export interface UsePanelDataResult {
  state: PanelDataState;
  /** Gap-filled, time-monotonic series; `[]` until a load succeeds. */
  series: PanelBucket[];
  /** The last successful `totalCount`; `0` before one lands. */
  totalCount: number;
  /** Set only when `state === 'error'`; a user-safe message. */
  errorMessage: string | null;
}

/** Mirrors query-service's own bucket-count default (see server/panel-data.ts). */
const DEFAULT_BUCKETS = 30;

/**
 * Fetches one panel's data. Re-fetches whenever `savedQueryId` or the active
 * range changes (e.g. the dashboard's `TimeRangePicker`). A request in flight
 * never clobbers a previous successful render with stale-looking blankness
 * beyond flipping to `loading`; a failure sets `error` with a safe message and
 * leaves the last series/count untouched (so a transient blip doesn't erase a
 * good chart) until the next successful load overwrites them.
 */
export function usePanelData(
  savedQueryId: string,
  range: { from: string; to: string },
  buckets: number = DEFAULT_BUCKETS,
): UsePanelDataResult {
  const [state, setState] = React.useState<PanelDataState>('loading');
  const [series, setSeries] = React.useState<PanelBucket[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setState('loading');
    setErrorMessage(null);

    loadPanelDataFn({ data: { savedQueryId, from: range.from, to: range.to, buckets } }).then(
      (outcome) => {
        if (cancelled) return;
        if (!outcome.ok) {
          setState('error');
          setErrorMessage(outcome.message);
          return;
        }
        setSeries(gapFillBuckets(outcome.data.buckets, range.from, range.to, buckets));
        setTotalCount(outcome.data.totalCount);
        setState('default');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [savedQueryId, range.from, range.to, buckets]);

  return { state, series, totalCount, errorMessage };
}
