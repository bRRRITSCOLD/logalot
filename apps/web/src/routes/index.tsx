import { createFileRoute, redirect } from '@tanstack/react-router';

// The bare entry point bounces into the authenticated app. The `/app` route sits
// behind the `_authed` guard, which redirects to /login when there is no session,
// so unauthenticated users never land on protected content.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/app' });
  },
});
