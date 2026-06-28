import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ErrorState, LoadingState } from '../../components/states';
import { AlertManager } from '../../features/alerts';
import { useSession } from '../../hooks/use-session';
import {
  createAlertRuleFn,
  deleteAlertRuleFn,
  loadAlertRulesFn,
  updateAlertRuleFn,
} from '../../server/admin';

// Alert management. The route stays thin: the loader fetches the tenant's rules via
// the BFF (token-derived tenant, never a param), the component renders the alerts
// feature surface and wires its mutations back to the BFF server functions. RBAC is
// enforced server-side on every call; the UI only mirrors it to hide write actions
// a member can't perform (the rules themselves are readable by member + admin).
export const Route = createFileRoute('/_authed/alerts')({
  loader: () => loadAlertRulesFn(),
  pendingComponent: () => <LoadingState label="Loading alerts…" />,
  errorComponent: () => <ErrorState message="Couldn't load alerts. Please try again." />,
  component: AlertsPage,
});

function AlertsPage() {
  const outcome = Route.useLoaderData();
  const router = useRouter();
  const session = useSession();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-2xl text-fg-default">Alerts</h1>
        <p className="text-fg-muted text-sm">
          Rules that watch tenant{' '}
          <code className="font-mono text-fg-default">{session.tenantId}</code> for conditions worth
          knowing about.
        </p>
      </header>

      {outcome.ok ? (
        <AlertManager
          rules={outcome.data}
          create={(body) => createAlertRuleFn({ data: body })}
          update={(id, patch) => updateAlertRuleFn({ data: { id, patch } })}
          remove={(id) => deleteAlertRuleFn({ data: { id } })}
          onChanged={() => router.invalidate()}
        />
      ) : (
        <ErrorState message={outcome.error.message} />
      )}
    </div>
  );
}
