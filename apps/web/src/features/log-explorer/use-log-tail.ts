import * as React from 'react';
import { parseGapFrame, parseLogFrame, type TailLogEvent } from './tail-event';

// ── useLogTail: the live-tail state machine ─────────────────────────────────
//
// Owns the browser end of the SSE stream: it opens an EventSource against the
// same-origin BFF (`/api/tail`, which injects the bearer token — the browser never
// holds one), parses frames, buffers a BOUNDED ring of rows, and surfaces
// pause/resume + reconnect/backoff + gap indication.
//
// Design choices that matter:
//   • Bounded buffer (`maxItems`): a high-rate stream can never grow the DOM or
//     memory without limit — oldest rows are dropped (the live tail is "now"; the
//     scrollback is finite, history is search's job, #22).
//   • Coalesced flush (`flushIntervalMs`): incoming frames accumulate in a ref and
//     are committed to React state on a fixed cadence, so a burst of N frames costs
//     one render, not N. The timers are plain setInterval/setTimeout so tests drive
//     them deterministically with fake timers.
//   • We own reconnection (we `close()` on error and reconnect with backoff) instead
//     of leaning on EventSource's native auto-retry, so the backoff is bounded,
//     testable, and every successful reconnect emits a `reconnect` gap marker —
//     Redis pub/sub has no replay (ADR-0006), so a reconnect ALWAYS means a
//     potential hole in the stream and the UI must say so.
//   • Reconnection is BOUNDED: a dead session surfaces to the browser only as an
//     EventSource `error` (it can't read the 401 status), which is indistinguishable
//     from a transient drop. So after `maxReconnectAttempts` consecutive failures
//     with no successful `open` we STOP looping, go to a terminal `offline` status,
//     and fire `onReconnectExhausted` — the owner probes the session (server fn) and
//     redirects to /login if it's gone, or offers a manual `reconnect()`. Without
//     this the tail would spin forever in "Reconnecting…" against a 401.
//   • The EventSource is injected (`createEventSource`) so component/integration
//     tests run against a mock — jsdom has no EventSource and we never want a live
//     query-service in unit tests.

export type TailStatus =
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'paused'
  // Terminal: bounded reconnects exhausted (likely a dead session or hard outage).
  // The owner decides what happens next (redirect to /login, or manual reconnect()).
  | 'offline';

/** A row in the tail buffer: either a log event or a gap marker, in stream order. */
export type TailItem =
  | { kind: 'log'; seq: number; event: TailLogEvent }
  | { kind: 'gap'; seq: number; reason: 'dropped' | 'reconnect'; dropped: number };

// Distributive Omit so a not-yet-sequenced item keeps its discriminated-union shape
// (a plain `Omit<TailItem, 'seq'>` would collapse the variants to their common keys).
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type NewTailItem = DistributiveOmit<TailItem, 'seq'>;

/** Minimal EventSource surface the hook depends on (native EventSource satisfies it). */
export interface TailMessageEvent {
  data: string;
}
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: TailMessageEvent) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface UseLogTailOptions {
  /** Same-origin BFF endpoint. Defaults to the `/api/tail` proxy route. */
  url?: string;
  /** Max rows retained in the scrollback ring. Oldest beyond this are dropped. */
  maxItems?: number;
  /** Flush cadence (ms) for coalescing bursts of frames into one render. */
  flushIntervalMs?: number;
  /** Reconnect backoff schedule (ms); the last entry is the steady-state interval. */
  backoffMs?: readonly number[];
  /**
   * Consecutive failed reconnects (no successful `open`) before the stream gives up
   * and goes terminal `offline`. Bounds the retry loop so a dead session (401, which
   * surfaces only as an opaque EventSource error) can't spin forever.
   */
  maxReconnectAttempts?: number;
  /**
   * Fired once when the stream goes terminal `offline`. The owner should probe the
   * session and either redirect to /login (session gone) or call `reconnect()`.
   */
  onReconnectExhausted?: () => void;
  /** Injectable EventSource constructor (tests pass a mock; default is native). */
  createEventSource?: EventSourceFactory;
}

export interface UseLogTail {
  items: TailItem[];
  status: TailStatus;
  paused: boolean;
  pause(): void;
  resume(): void;
  clear(): void;
  /** Re-arm the stream from a terminal `offline` state (manual retry). */
  reconnect(): void;
  /** Lifetime totals — they intentionally survive `clear()`. */
  receivedCount: number;
  droppedCount: number;
  reconnectCount: number;
}

const DEFAULT_URL = '/api/tail';
const DEFAULT_MAX_ITEMS = 1000;
const DEFAULT_FLUSH_MS = 60;
const DEFAULT_BACKOFF: readonly number[] = [500, 1000, 2000, 5000, 10000];
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

const defaultFactory: EventSourceFactory = (url) =>
  // Same-origin: the httpOnly session cookies ride along automatically, so the BFF
  // can authenticate without the browser ever handling a token.
  new EventSource(url, { withCredentials: false });

interface Stats {
  received: number;
  dropped: number;
  reconnects: number;
}

export function useLogTail(options: UseLogTailOptions = {}): UseLogTail {
  const {
    url = DEFAULT_URL,
    maxItems = DEFAULT_MAX_ITEMS,
    flushIntervalMs = DEFAULT_FLUSH_MS,
    backoffMs = DEFAULT_BACKOFF,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    onReconnectExhausted,
    createEventSource = defaultFactory,
  } = options;

  const [items, setItems] = React.useState<TailItem[]>([]);
  const [status, setStatus] = React.useState<TailStatus>('connecting');
  const [paused, setPaused] = React.useState(false);
  const [stats, setStats] = React.useState<Stats>({ received: 0, dropped: 0, reconnects: 0 });

  // ── mutable connection state (refs avoid stale closures in EventSource cbs) ──
  const esRef = React.useRef<EventSourceLike | null>(null);
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptRef = React.useRef(0);
  const stoppedRef = React.useRef(false);
  const sawOpenRef = React.useRef(false);
  const wantGapOnOpenRef = React.useRef(false);
  const seqRef = React.useRef(0);
  const pendingRef = React.useRef<TailItem[]>([]);
  const statsRef = React.useRef<Stats>({ received: 0, dropped: 0, reconnects: 0 });

  // Keep the latest option values reachable from stable callbacks.
  const cfgRef = React.useRef({
    url,
    maxItems,
    flushIntervalMs,
    backoffMs,
    maxReconnectAttempts,
    onReconnectExhausted,
    createEventSource,
  });
  cfgRef.current = {
    url,
    maxItems,
    flushIntervalMs,
    backoffMs,
    maxReconnectAttempts,
    onReconnectExhausted,
    createEventSource,
  };

  const pushItem = React.useCallback((item: NewTailItem) => {
    pendingRef.current.push({ ...item, seq: seqRef.current++ } as TailItem);
  }, []);

  const flush = React.useCallback(() => {
    const pending = pendingRef.current;
    const nextStats = statsRef.current;
    pendingRef.current = [];
    if (pending.length > 0) {
      const max = cfgRef.current.maxItems;
      setItems((prev) => {
        const merged = prev.length === 0 ? pending : prev.concat(pending);
        return merged.length > max ? merged.slice(merged.length - max) : merged;
      });
    }
    setStats((prev) =>
      prev.received === nextStats.received &&
      prev.dropped === nextStats.dropped &&
      prev.reconnects === nextStats.reconnects
        ? prev
        : { ...nextStats },
    );
  }, []);

  const closeSource = React.useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const connect = React.useCallback(() => {
    if (stoppedRef.current) return;
    const es = cfgRef.current.createEventSource(cfgRef.current.url);
    esRef.current = es;

    es.addEventListener('open', () => {
      attemptRef.current = 0;
      if (wantGapOnOpenRef.current) {
        pushItem({ kind: 'gap', reason: 'reconnect', dropped: 0 });
        statsRef.current.reconnects += 1;
        wantGapOnOpenRef.current = false;
      }
      sawOpenRef.current = true;
      setStatus('streaming');
    });

    es.addEventListener('message', (ev) => {
      const log = parseLogFrame(ev.data);
      if (!log) return; // one corrupt frame never stalls the stream
      pushItem({ kind: 'log', event: log });
      statsRef.current.received += 1;
    });

    // Slow-consumer drops, surfaced inline so the hole is visible in the timeline.
    es.addEventListener('gap', (ev) => {
      const dropped = parseGapFrame(ev.data);
      pushItem({ kind: 'gap', reason: 'dropped', dropped });
      statsRef.current.dropped += dropped;
    });

    es.addEventListener('error', () => {
      // We own reconnection: tear down this source and schedule a backed-off retry
      // rather than letting EventSource auto-retry on its own (uncontrolled) clock.
      if (stoppedRef.current) return;
      closeSource();
      wantGapOnOpenRef.current = true; // a reopen means missed events → mark a gap

      // Bounded retries: a 401 (dead session) surfaces here as an opaque error, so we
      // cannot loop forever. Once consecutive failures (no `open` resets attemptRef)
      // hit the cap, go terminal `offline` and hand off to the owner.
      if (attemptRef.current >= cfgRef.current.maxReconnectAttempts) {
        setStatus('offline');
        cfgRef.current.onReconnectExhausted?.();
        return;
      }

      setStatus('reconnecting');
      const backoff = cfgRef.current.backoffMs;
      const idx = Math.min(attemptRef.current, backoff.length - 1);
      const delay = backoff[idx] ?? backoff[backoff.length - 1] ?? 1000;
      attemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
    });
  }, [pushItem, closeSource]);

  const stop = React.useCallback(() => {
    stoppedRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    closeSource();
    flush(); // commit anything buffered before going idle
  }, [closeSource, flush]);

  // Start/stop the stream as the paused flag (and url) change. Cleanup on unmount or
  // before any re-run tears the current connection down (so there is never a leaked
  // EventSource or pending reconnect timer). `url` is a TRIGGER dep — it is read via
  // cfgRef inside connect(), but listing it here reconnects the stream if the BFF
  // endpoint ever changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: url triggers a reconnect.
  React.useEffect(() => {
    if (paused) {
      // The previous run's cleanup already called stop(); just reflect the state.
      setStatus('paused');
      return;
    }
    stoppedRef.current = false;
    attemptRef.current = 0;
    if (sawOpenRef.current) {
      // Resuming/reconnecting after a prior open means events were missed → gap.
      wantGapOnOpenRef.current = true;
      setStatus('reconnecting');
    } else {
      setStatus('connecting');
    }
    flushTimerRef.current = setInterval(flush, cfgRef.current.flushIntervalMs);
    connect();
    return () => {
      stop();
    };
  }, [paused, url, connect, flush, stop]);

  const pause = React.useCallback(() => setPaused(true), []);
  const resume = React.useCallback(() => setPaused(false), []);

  // Manual re-arm out of terminal `offline` (the owner offers this after confirming
  // the session is still valid — a hard upstream outage rather than a 401).
  const reconnect = React.useCallback(() => {
    if (stoppedRef.current) return; // unmounted/paused — the effect owns the lifecycle
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    attemptRef.current = 0;
    wantGapOnOpenRef.current = true; // we were disconnected → a hole is possible
    if (!flushTimerRef.current) {
      flushTimerRef.current = setInterval(flush, cfgRef.current.flushIntervalMs);
    }
    setStatus('reconnecting');
    connect();
  }, [connect, flush]);

  const clear = React.useCallback(() => {
    // Wipe the visible scrollback; lifetime counters (received/dropped/reconnect)
    // deliberately persist so "cleared the screen" never lies about stream health.
    pendingRef.current = [];
    setItems([]);
  }, []);

  return {
    items,
    status,
    paused,
    pause,
    resume,
    clear,
    reconnect,
    receivedCount: stats.received,
    droppedCount: stats.dropped,
    reconnectCount: stats.reconnects,
  };
}
