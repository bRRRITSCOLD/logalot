import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ErrorState, LoadingState } from '../../../components/states';
import { DashboardDetail } from '../../../features/dashboards';
import { loadDashboardFn, loadSavedQueriesFn } from '../../../server/dashboards';

// Dashboard detail. The route stays thin: the loader fetches the dashboard AND
// the tenant's saved queries in parallel (the latter drives each panel's
// subtitle via `savedQuerySubtitle`) via the BFF, and the component renders
// `DashboardDetail` — the panel grid + visualizations (#194/#195/#196).
export const Route = createFileRoute('/_authed/dashboards/$dashboardId')({
  loader: async ({ params }) => {
    const [dashboard, savedQueries] = await Promise.all([
      loadDashboardFn({ data: { id: params.dashboardId } }),
      loadSavedQueriesFn(),
    ]);
    return { dashboard, savedQueries };
  },
  pendingComponent: () => <LoadingState label="Loading dashboard…" />,
  errorComponent: () => <ErrorState message="Couldn't load this dashboard. Please try again." />,
  component: DashboardDetailPage,
});

function DashboardDetailPage() {
  const { dashboard, savedQueries } = Route.useLoaderData();
  const router = useRouter();

  if (!dashboard.ok) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <ErrorState message={dashboard.error.message} />
      </div>
    );
  }

  return (
    <DashboardDetail
      dashboard={dashboard.data}
      savedQueries={savedQueries.ok ? savedQueries.data : []}
      onChanged={() => router.invalidate()}
    />
  );
}
