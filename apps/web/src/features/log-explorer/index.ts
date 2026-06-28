// Public API of the log-explorer feature. The live-tail page imports `LogExplorer`;
// #22 (historical search) is expected to reuse the lower-level surface —
// `FilterBar`, `LogList`, `LogRow`/`GapRow`, the `LogFilters` model + `matchesFilters`
// predicate, and the `tailLogEventSchema` log-event shape — to render results into
// the SAME explorer chrome. Import only what you need (interface segregation).

export { FilterBar, type FilterBarProps } from './filter-bar';
export {
  EMPTY_FILTERS,
  filtersActive,
  type LogFilters,
  matchesFilters,
} from './filtering';
export { LogExplorer, type LogExplorerProps } from './log-explorer';
export { LogList, type LogListProps } from './log-list';
export { formatTimestamp, GapRow, type GapRowProps, LogRow, type LogRowProps } from './log-row';
export {
  type GapFrame,
  gapFrameSchema,
  LOG_LEVELS,
  parseGapFrame,
  parseLogFrame,
  type TailLogEvent,
  tailLogEventSchema,
} from './tail-event';
export { TailToolbar, type TailToolbarProps } from './tail-toolbar';
export {
  type EventSourceFactory,
  type EventSourceLike,
  type TailItem,
  type TailStatus,
  type UseLogTail,
  type UseLogTailOptions,
  useLogTail,
} from './use-log-tail';
