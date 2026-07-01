// Public API of the dashboards feature surface (types + helpers, plus the list
// and detail surface components; see the plan's barrel chain, T4/T5/T8/T9 add
// those serially).

export { DashboardDetail, type DashboardDetailProps } from './dashboard-detail';
export { DashboardList, type DashboardListProps } from './dashboard-list';
export {
  buildPanelDataParams,
  gapFillBuckets,
  MAX_PANEL_BUCKETS,
  type PanelBucket,
  type PanelDataOutcome,
  type PanelDataParamsInput,
  type PanelDataResult,
  panelDataResponseSchema,
} from './panel-data';
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
