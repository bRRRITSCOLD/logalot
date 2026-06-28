import * as React from 'react';
import type { ClientSession } from '../server/session';

// Read-only access to the server-derived session for client components. The value
// is supplied by the authenticated layout (which obtained it from the BFF), so
// there is no way for a component to mint or mutate tenancy — it can only read it.
const SessionContext = React.createContext<ClientSession | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: ClientSession;
  children: React.ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Returns the current session. Throws if used outside an authenticated subtree. */
export function useSession(): ClientSession {
  const session = React.useContext(SessionContext);
  if (!session) {
    throw new Error('useSession must be used within an authenticated route (<SessionProvider>)');
  }
  return session;
}
