import type { DashboardResponse, Panel, SavedQueryResponse } from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  SelectField,
  type SelectOption,
  TextField,
} from '../../components/ui';
import { updateDashboardFn } from '../../server/dashboards';
import { defaultGrid, newPanelId, PANEL_TYPES, type UiPanelType, upsertPanel } from './types';

export interface PanelDialogProps {
  dashboard: DashboardResponse;
  savedQueries: SavedQueryResponse[];
  /** The panel being edited, or `null` to add a new one. */
  editing: Panel | null;
  onClose: () => void;
  /** Re-run the loader after a successful mutation (router.invalidate in the route). */
  onSaved: () => void | Promise<void>;
}

const PANEL_TYPE_LABELS: Record<UiPanelType, string> = {
  timeseries: 'Timeseries',
  stat: 'Stat',
};

const PANEL_TYPE_OPTIONS: SelectOption[] = PANEL_TYPES.map((type) => ({
  value: type,
  label: PANEL_TYPE_LABELS[type],
}));

/**
 * Add/edit-panel dialog. There is no per-panel endpoint (see #197 / dashboard.ts) —
 * a save clones `dashboard.layout.panels[]`, appends (add) or replaces-by-id
 * (edit) the panel being edited, and PATCHes the WHOLE layout back. Grid
 * placement is left untouched on edit and defaulted (top-left) on add; a
 * dedicated drag-to-place editor is a future enhancement (YAGNI for v1).
 */
export function PanelDialog({
  dashboard,
  savedQueries,
  editing,
  onClose,
  onSaved,
}: PanelDialogProps) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const isEditing = editing !== null;

  const form = useForm({
    defaultValues: {
      title: editing?.title ?? '',
      type: (editing?.type === 'stat' ? 'stat' : 'timeseries') as UiPanelType,
      savedQueryId: editing?.savedQueryId ?? savedQueries[0]?.id ?? '',
    },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const title = value.title.trim();
      if (!title) {
        setFormError('Title is required.');
        return;
      }
      if (!value.savedQueryId) {
        setFormError('A saved query is required.');
        return;
      }
      const panel: Panel = {
        id: editing?.id ?? newPanelId(),
        type: value.type,
        title,
        savedQueryId: value.savedQueryId,
        viz: editing?.viz ?? {},
        grid: editing?.grid ?? defaultGrid(),
      };
      const outcome = await updateDashboardFn({
        data: {
          id: dashboard.id,
          patch: { layout: { panels: upsertPanel(dashboard.layout.panels, panel) } },
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
      <DialogContent
        title={isEditing ? 'Edit panel' : 'Add panel'}
        description="Pick a saved query to visualize and how to display it."
      >
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
            <Alert tone="danger" title="Couldn't save the panel">
              {formError}
            </Alert>
          ) : null}
          <form.Field name="title">
            {(field) => (
              <TextField
                label="Title"
                placeholder="5xx rate"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="type">
            {(field) => (
              <SelectField
                label="Type"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value as UiPanelType)}
                options={PANEL_TYPE_OPTIONS}
              />
            )}
          </form.Field>
          <form.Field name="savedQueryId">
            {(field) => (
              <SelectField
                label="Saved query"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                options={savedQueries.map((q) => ({ value: q.id, label: q.name }))}
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
                  {isSubmitting ? 'Saving…' : isEditing ? 'Save changes' : 'Add panel'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
