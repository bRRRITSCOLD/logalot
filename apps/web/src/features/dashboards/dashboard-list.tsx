import type { CreateDashboardRequest, DashboardResponse } from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import { Link } from '@tanstack/react-router';
import * as React from 'react';
import { EmptyState } from '../../components/states';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  TextField,
} from '../../components/ui';
import { useCan } from '../../hooks/use-can';
import type { DashboardOutcome } from '../../server/dashboards';

export interface DashboardListProps {
  dashboards: DashboardResponse[];
  create: (body: CreateDashboardRequest) => Promise<DashboardOutcome<DashboardResponse>>;
  remove: (id: string) => Promise<DashboardOutcome<void>>;
  /** Re-run the loader after a successful mutation (router.invalidate in the route). */
  onChanged: () => void | Promise<void>;
}

// The dashboards list surface: a Card grid of the tenant's dashboards, each a
// <Link> to its detail page, with create/delete gated behind useCan (display-only
// mirror — the control-plane re-checks every mutation server-side).
export function DashboardList({ dashboards, create, remove, onChanged }: DashboardListProps) {
  const can = useCan();
  const canCreate = can('dashboard:create');
  const canDelete = can('dashboard:delete');

  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<DashboardResponse | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const onDelete = React.useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const outcome = await remove(deleting.id);
    setDeleteBusy(false);
    if (outcome.ok) {
      setDeleting(null);
      await onChanged();
    } else {
      setDeleteError(outcome.error.message);
    }
  }, [deleting, remove, onChanged]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-fg-muted text-sm">
          {dashboards.length} {dashboards.length === 1 ? 'dashboard' : 'dashboards'}
        </p>
        {canCreate ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            New dashboard
          </Button>
        ) : null}
      </div>

      {dashboards.length === 0 ? (
        <EmptyState
          title="No dashboards yet"
          description={
            canCreate
              ? 'Create a dashboard to start visualizing your logs.'
              : 'A workspace admin can create dashboards.'
          }
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                New dashboard
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((dashboard) => (
            <li key={dashboard.id}>
              <Card>
                <CardHeader className="flex-row items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      to="/dashboards/$dashboardId"
                      params={{ dashboardId: dashboard.id }}
                      className="min-w-0"
                    >
                      <CardTitle className="truncate text-base hover:underline">
                        {dashboard.name}
                      </CardTitle>
                    </Link>
                    {dashboard.description ? (
                      <p className="truncate text-fg-muted text-sm">{dashboard.description}</p>
                    ) : null}
                  </div>
                  {canDelete ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleting(dashboard);
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent>
                  <Badge tone="neutral">
                    {dashboard.layout.panels.length}{' '}
                    {dashboard.layout.panels.length === 1 ? 'panel' : 'panels'}
                  </Badge>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <CreateDashboardDialog
          create={create}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await onChanged();
          }}
        />
      ) : null}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent
          title="Delete dashboard"
          description={
            deleting
              ? `“${deleting.name}” and its panels will be permanently removed. This cannot be undone.`
              : ''
          }
        >
          {deleteError ? (
            <Alert tone="danger" title="Couldn't delete the dashboard">
              {deleteError}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={deleteBusy} onClick={onDelete}>
              {deleteBusy ? 'Deleting…' : 'Delete dashboard'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateDashboardDialog({
  create,
  onClose,
  onCreated,
}: {
  create: DashboardListProps['create'];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { name: '', description: '' },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const name = value.name.trim();
      if (!name) {
        setFormError('Name is required.');
        return;
      }
      const body: CreateDashboardRequest = {
        name,
        description: value.description.trim() || undefined,
        layout: { panels: [] },
      };
      const outcome = await create(body);
      if (outcome.ok) {
        await onCreated();
      } else {
        setFormError(outcome.error.message);
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="New dashboard" description="Give it a name to get started.">
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
            <Alert tone="danger" title="Couldn't create the dashboard">
              {formError}
            </Alert>
          ) : null}
          <form.Field name="name">
            {(field) => (
              <TextField
                label="Name"
                placeholder="Errors overview"
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
                  {isSubmitting ? 'Creating…' : 'Create dashboard'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
