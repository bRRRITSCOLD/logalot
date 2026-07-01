import { createFileRoute } from '@tanstack/react-router';
import { ErrorState, LoadingState } from '../../../components/states';
import { loadDashboardFn } from '../../../server/dashboards';

// Dashboard detail — minimal placeholder so the list surface's per-row
// `<Link to="/dashboards/$dashboardId">` (#193) resolves and typechecks. The
// full panel grid + visualizations land in a follow-up (plan T8/T9); this route
// already fetches the real dashboard via the BFF and renders its identity.
export const Route = createFileRoute('/_authed/dashboards/$dashboardId')({
  loader: ({ params }) => loadDashboardFn({ data: { id: params.dashboardId } }),
  pendingComponent: () => <LoadingState label="Loading dashboard…" />,
  errorComponent: () => <ErrorState message="Couldn't load this dashboard. Please try again." />,
  component: DashboardDetailPage,
});

function DashboardDetailPage() {
  const outcome = Route.useLoaderData();

  if (!outcome.ok) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <ErrorState message={outcome.error.message} />
      </div>
    );
  }

  const dashboard = outcome.data;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-2xl text-fg-default">{dashboard.name}</h1>
        {dashboard.description ? (
          <p className="text-fg-muted text-sm">{dashboard.description}</p>
        ) : null}
      </header>
      <p className="text-fg-muted text-sm">
        {dashboard.layout.panels.length} {dashboard.layout.panels.length === 1 ? 'panel' : 'panels'}{' '}
        — the panel grid ships in a follow-up.
      </p>
    </div>
  );
}
