import type { DashboardResponse, SavedQueryResponse } from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import { parseAsString, useQueryStates } from 'nuqs';
import * as React from 'react';
import { Alert, Button, Dialog, DialogContent, DialogFooter, TextField } from '../../components/ui';
import { useCan } from '../../hooks/use-can';
import { updateDashboardFn } from '../../server/dashboards';
import { PanelGrid } from './panel-grid';
import { type TimeRange, TimeRangePicker } from './time-range-picker';

export interface DashboardDetailProps {
  dashboard: DashboardResponse;
  savedQueries: SavedQueryResponse[];
  /** Re-run the loader after a successful mutation (router.invalidate in the route). */
  onChanged: () => void | Promise<void>;
}

/** The window shown before the user picks an explicit range: last hour. */
const DEFAULT_RANGE_MS = 60 * 60 * 1000;

function computeDefaultRange(): TimeRange {
  const to = Date.now();
  return { from: new Date(to - DEFAULT_RANGE_MS).toISOString(), to: new Date(to).toISOString() };
}

/**
 * Dashboard detail: header (name/description, an edit action, and the
 * `TimeRangePicker`) plus the panel grid. The time range is URL state (nuqs,
 * `?from=&to=`) so a view is shareable and changing it never re-fetches the
 * dashboard itself — only `PanelGrid`'s panels react to it (each panel owns its
 * own fetch; see `usePanelData`). The range defaults to "last hour" computed
 * once on mount (stable across re-renders) until the user picks a preset or
 * absolute range, at which point it's persisted to the URL.
 */
export function DashboardDetail({ dashboard, savedQueries, onChanged }: DashboardDetailProps) {
  const can = useCan();
  const canEdit = can('dashboard:update');
  const [editing, setEditing] = React.useState(false);

  const [urlRange, setUrlRange] = useQueryStates(
    { from: parseAsString.withDefault(''), to: parseAsString.withDefault('') },
    { history: 'replace' },
  );

  const defaultRange = React.useMemo(computeDefaultRange, []);
  const range: TimeRange =
    urlRange.from !== '' && urlRange.to !== ''
      ? { from: urlRange.from, to: urlRange.to }
      : defaultRange;

  const onRangeChange = React.useCallback(
    (next: TimeRange) => {
      void setUrlRange({ from: next.from, to: next.to });
    },
    [setUrlRange],
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-semibold text-2xl text-fg-default">{dashboard.name}</h1>
          {dashboard.description ? (
            <p className="text-fg-muted text-sm">{dashboard.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit dashboard
            </Button>
          ) : null}
          <TimeRangePicker value={range} onChange={onRangeChange} />
        </div>
      </header>

      <PanelGrid panels={dashboard.layout.panels} savedQueries={savedQueries} range={range} />

      {editing ? (
        <EditDashboardDialog
          dashboard={dashboard}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function EditDashboardDialog({
  dashboard,
  onClose,
  onSaved,
}: {
  dashboard: DashboardResponse;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { name: dashboard.name, description: dashboard.description ?? '' },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const name = value.name.trim();
      if (!name) {
        setFormError('Name is required.');
        return;
      }
      const outcome = await updateDashboardFn({
        data: {
          id: dashboard.id,
          patch: { name, description: value.description.trim() || null },
        },
      });
      if (outcome.ok) {
        await onSaved();
      } else {
        setFormError(outcome.error.message);
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Edit dashboard" description="Update its name or description.">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-4"
        >
          {formError ? (
            <Alert tone="danger" title="Couldn't update the dashboard">
              {formError}
            </Alert>
          ) : null}
          <form.Field name="name">
            {(field) => (
              <TextField
                label="Name"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <TextField
                label="Description (optional)"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Saving…' : 'Save changes'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
