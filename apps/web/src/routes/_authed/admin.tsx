import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ErrorState, LoadingState } from '../../components/states';
import { AdminDashboard, type AdminExecutors } from '../../features/admin';
import { useSession } from '../../hooks/use-session';
import {
  createApiKeyFn,
  createUserFn,
  deleteUserFn,
  loadAdminFn,
  revokeApiKeyFn,
  updateRetentionFn,
  updateUserFn,
} from '../../server/admin';

// Tenant / key / user / retention admin. The route stays thin: the loader fetches
// everything in one BFF round-trip, GATING the privileged fetches (users, keys) on
// the role decoded SERVER-SIDE from the JWT — a member's browser never receives
// that data. The component renders the admin surface and wires mutations back to
// the BFF, which the control-plane re-authorizes on every call.
export const Route = createFileRoute('/_authed/admin')({
  loader: () => loadAdminFn(),
  pendingComponent: () => <LoadingState label="Loading workspace settings…" />,
  errorComponent: () => (
    <ErrorState message="Couldn't load workspace settings. Please try again." />
  ),
  component: AdminPage,
});

function AdminPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const session = useSession();
  const onChanged = () => router.invalidate();

  const executors: AdminExecutors = {
    issueApiKey: (body) => createApiKeyFn({ data: body }),
    revokeApiKey: (id) => revokeApiKeyFn({ data: { id } }),
    createUser: (body) => createUserFn({ data: body }),
    updateUser: (id, patch) => updateUserFn({ data: { id, patch } }),
    deleteUser: (id) => deleteUserFn({ data: { id } }),
    updateRetention: (body) => updateRetentionFn({ data: body }),
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-2xl text-fg-default">Admin</h1>
        <p className="text-fg-muted text-sm">
          Settings for tenant <code className="font-mono text-fg-default">{session.tenantId}</code>.
        </p>
      </header>

      <AdminDashboard data={data} executors={executors} onChanged={onChanged} />
    </div>
  );
}
