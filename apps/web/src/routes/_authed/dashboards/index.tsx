import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ErrorState, LoadingState } from '../../../components/states';
import { DashboardList } from '../../../features/dashboards';
import { useSession } from '../../../hooks/use-session';
import { createDashboardFn, deleteDashboardFn, loadDashboardsFn } from '../../../server/dashboards';

// Dashboards list. The route stays thin: the loader fetches the tenant's
// dashboards via the BFF (token-derived tenant, never a param), the component
// renders the list surface and wires its mutations back to the BFF server
// functions. RBAC is enforced server-side on every call; the UI only mirrors it
// to hide write actions a member can't perform (list/read are member-visible).
export const Route = createFileRoute('/_authed/dashboards/')({
  loader: () => loadDashboardsFn(),
  pendingComponent: () => <LoadingState label="Loading dashboards…" />,
  errorComponent: () => <ErrorState message="Couldn't load dashboards. Please try again." />,
  component: DashboardsPage,
});

function DashboardsPage() {
  const outcome = Route.useLoaderData();
  const router = useRouter();
  const session = useSession();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-2xl text-fg-default">Dashboards</h1>
        <p className="text-fg-muted text-sm">
          Visualizations for tenant{' '}
          <code className="font-mono text-fg-default">{session.tenantId}</code>.
        </p>
      </header>

      {outcome.ok ? (
        <DashboardList
          dashboards={outcome.data}
          create={(body) => createDashboardFn({ data: body })}
          remove={(id) => deleteDashboardFn({ data: { id } })}
          onChanged={() => router.invalidate()}
        />
      ) : (
        <ErrorState message={outcome.error.message} />
      )}
    </div>
  );
}
