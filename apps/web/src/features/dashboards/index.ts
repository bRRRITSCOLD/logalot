// Public API of the dashboards feature surface (types + helpers only — no
// components yet; see the plan's barrel chain, T4/T5/T8/T9 add those serially).
export {
  type DashboardDialogState,
  type DashboardLayout,
  type DashboardResponse,
  defaultGrid,
  newPanelId,
  PANEL_TYPES,
  type Panel,
  type PanelDialogState,
  type PanelDraft,
  type PanelGrid,
  type PanelType,
  savedQuerySubtitle,
  type UiPanelType,
} from './types';
