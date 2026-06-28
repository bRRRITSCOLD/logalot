import { createFileRoute, Outlet, redirect, useRouter } from '@tanstack/react-router';
import { AppShell } from '../components/shell';
import { SessionProvider } from '../hooks/use-session';
import { getSession, logoutFn } from '../server/auth';

// Authentication guard for every route nested under it. It runs on the server
// during SSR and on the client during navigation; either way an absent/expired
// session (after a silent-refresh attempt inside getSession) redirects to /login
// BEFORE any protected component renders — the guard fails closed.
export const Route = createFileRoute('/_authed')({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) {
      throw redirect({ to: '/login' });
    }
    // Expose the server-derived session to child loaders + the layout.
    return { session };
  },
  loader: ({ context }) => ({ session: context.session }),
  component: AuthedLayout,
});

function AuthedLayout() {
  const { session } = Route.useLoaderData();
  const router = useRouter();

  const onLogout = async () => {
    await logoutFn();
    await router.invalidate();
    await router.navigate({ to: '/login' });
  };

  return (
    <SessionProvider session={session}>
      <AppShell session={session} onLogout={onLogout}>
        <Outlet />
      </AppShell>
    </SessionProvider>
  );
}
