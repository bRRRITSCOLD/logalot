import type { SavedQueryResponse } from '@logalot/contracts';
import { EmptyState } from '../../components/states';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../../components/ui';
import { StatPanel } from './stat-panel';
import { TimeseriesChart } from './timeseries-chart';
import type { Panel } from './types';
import { savedQuerySubtitle } from './types';
import { usePanelData } from './use-panel-data';

export interface PanelGridRange {
  /** RFC3339 range start. */
  from: string;
  /** RFC3339 range end. */
  to: string;
}

export interface PanelGridProps {
  panels: Panel[];
  savedQueries: SavedQueryResponse[];
  range: PanelGridRange;
  /** Show per-panel edit/remove controls (display-only RBAC mirror; see useCan). */
  canEdit?: boolean;
  onEditPanel?: (panel: Panel) => void;
  onRemovePanel?: (panel: Panel) => void;
}

/**
 * Lays out a dashboard's `layout.panels[]` on a CSS grid, honoring each panel's
 * own `grid` placement ({x, y, w, h}) — the SAME coordinate system the panel
 * dialog writes (see `panel-dialog.tsx` / #197). Each panel is an independent
 * `DashboardPanelCard`: a per-panel fetch failure (or a slow panel) degrades ONLY
 * that card, never the grid as a whole (see `usePanelData`). The caller
 * (`dashboard-detail.tsx`) owns the RBAC gate and the actual mutations — this
 * component only renders the controls and forwards clicks.
 */
export function PanelGrid({
  panels,
  savedQueries,
  range,
  canEdit = false,
  onEditPanel,
  onRemovePanel,
}: PanelGridProps) {
  if (panels.length === 0) {
    return (
      <EmptyState
        title="No panels yet"
        description="Add a panel to start visualizing a saved query."
      />
    );
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      {panels.map((panel) => (
        <DashboardPanelCard
          key={panel.id}
          panel={panel}
          savedQueries={savedQueries}
          range={range}
          canEdit={canEdit}
          onEditPanel={onEditPanel}
          onRemovePanel={onRemovePanel}
        />
      ))}
    </div>
  );
}

function DashboardPanelCard({
  panel,
  savedQueries,
  range,
  canEdit,
  onEditPanel,
  onRemovePanel,
}: {
  panel: Panel;
  savedQueries: SavedQueryResponse[];
  range: PanelGridRange;
  canEdit: boolean;
  onEditPanel?: (panel: Panel) => void;
  onRemovePanel?: (panel: Panel) => void;
}) {
  const { state, series, totalCount, errorMessage } = usePanelData(panel.savedQueryId, range);

  return (
    <Card
      style={{
        gridColumn: `${panel.grid.x + 1} / span ${panel.grid.w}`,
        gridRow: `${panel.grid.y + 1} / span ${panel.grid.h}`,
      }}
      className="flex flex-col"
    >
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="truncate text-sm">{panel.title}</CardTitle>
          <p className="truncate text-fg-muted text-xs">
            {savedQuerySubtitle(panel, savedQueries)}
          </p>
        </div>
        {canEdit ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => onEditPanel?.(panel)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onRemovePanel?.(panel)}>
              Remove
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex-1">
        {panel.type === 'timeseries' ? (
          <TimeseriesChart series={series} state={state} errorMessage={errorMessage ?? undefined} />
        ) : panel.type === 'stat' ? (
          <StatPanel value={totalCount} state={state} errorMessage={errorMessage ?? undefined} />
        ) : (
          // `logs` is contract-level only, not yet wired into the UI (see types.ts).
          <EmptyState
            title="Unsupported panel"
            description={`Panel type "${panel.type}" isn't supported yet.`}
          />
        )}
      </CardContent>
    </Card>
  );
}
