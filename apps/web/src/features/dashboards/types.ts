/**
 * Public types + pure helpers for the dashboards feature slice.
 *
 * Re-exports the shared contract types (the wire shapes) and adds client-only
 * types/helpers used to drive the panel editor UI (draft state before a panel
 * is persisted, dialog open/edit state). Kept dependency-free (no React) so it
 * can be unit tested in isolation — see the frontend testing convention.
 */
import type {
  DashboardLayout,
  DashboardResponse,
  Panel,
  PanelGrid,
  PanelType,
  SavedQueryResponse,
} from '@logalot/contracts';

export type { DashboardLayout, DashboardResponse, Panel, PanelGrid, PanelType };

/** Panel visualization types the dashboards UI currently supports (YAGNI: `logs` is contract-level only, not yet wired into the editor). */
export type UiPanelType = 'timeseries' | 'stat';

/** Ordered list of UI-supported panel types, for select inputs. */
export const PANEL_TYPES: readonly UiPanelType[] = ['timeseries', 'stat'];

/**
 * In-progress panel state as edited in the panel dialog, before it is assembled
 * into a `Panel` and saved. Grid is optional while the user hasn't placed the
 * panel yet — `defaultGrid()` fills it in on save.
 */
export interface PanelDraft {
  id: string;
  type: UiPanelType;
  title: string;
  savedQueryId: string;
  grid?: PanelGrid;
}

/** Dashboard create/edit dialog open + editing state. */
export interface DashboardDialogState {
  open: boolean;
  editing: DashboardResponse | null;
}

/** Panel create/edit dialog open + editing state. */
export interface PanelDialogState {
  open: boolean;
  editing: PanelDraft | null;
}

/** Generates a unique-enough client-side id for a new panel draft. */
export function newPanelId(): string {
  return `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Default grid placement for a newly-added panel (top-left, single-cell-ish size). */
export function defaultGrid(): PanelGrid {
  return { x: 0, y: 0, w: 4, h: 2 };
}

/**
 * Resolves a saved query's display name for a panel subtitle. Falls back to a
 * truncated id when the saved query isn't found (e.g. deleted, or not yet loaded).
 */
export function savedQuerySubtitle(
  panel: Panel,
  savedQueries: readonly SavedQueryResponse[],
): string {
  const match = savedQueries.find((q) => q.id === panel.savedQueryId);
  return match ? match.name : `${panel.savedQueryId.slice(0, 8)}…`;
}
