// Public API of the historical-search feature (issue #22). The explorer route
// composes `LogSearch` as the "Search" mode beside the live tail, wiring the
// SearchFilters to nuqs URL state via the pure `filtersFromQuery`/`queryFromFilters`
// adapters. Import only what you need (interface segregation).

export { LogSearch, type LogSearchProps } from './log-search';
export { SearchBar, type SearchBarProps } from './search-bar';
export {
  buildSearchParams,
  EMPTY_SEARCH_FILTERS,
  filtersFromQuery,
  queryFromFilters,
  type SearchExecutor,
  type SearchFilters,
  type SearchOutcome,
  type SearchQueryState,
  type SearchResult,
  searchFiltersActive,
  searchResponseSchema,
  toRfc3339,
} from './search-query';
export {
  type SearchStatus,
  type UseLogSearch,
  type UseLogSearchOptions,
  useLogSearch,
} from './use-log-search';
