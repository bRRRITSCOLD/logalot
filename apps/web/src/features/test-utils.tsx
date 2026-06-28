import type { Role } from '@logalot/contracts';
import { render } from '@testing-library/react';
import type * as React from 'react';
import { SessionProvider } from '../hooks/use-session';
import type { ClientSession } from '../server/session';

// Shared test harness: render a feature surface inside a session of the given role,
// so the `useCan` RBAC mirror resolves. Tenancy is fixed and server-derived in
// production; here it is just a fixture.
export function sessionForRole(role: Role): ClientSession {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    role,
    expiresAt: 2_000_000_000,
  };
}

export function renderWithRole(role: Role, ui: React.ReactNode) {
  return render(<SessionProvider session={sessionForRole(role)}>{ui}</SessionProvider>);
}
