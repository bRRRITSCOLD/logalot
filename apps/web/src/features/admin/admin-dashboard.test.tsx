import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminData, AdminOutcome } from '../../server/admin';
import { renderWithRole } from '../test-utils';
import { AdminDashboard, type AdminExecutors } from './admin-dashboard';

const ok = <T,>(data: T): AdminOutcome<T> => ({ ok: true, data });

const tenant = {
  id: '00000000-0000-0000-0000-0000000000aa',
  publicId: 'acme',
  name: 'Acme',
  status: 'active' as const,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const retention = {
  tenantId: tenant.id,
  hotDays: 30,
  coldDays: 365,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const executors: AdminExecutors = {
  issueApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  updateRetention: vi.fn(),
};

function memberData(): AdminData {
  // Server gated the privileged fetches: a member's payload carries NO users/keys.
  return {
    role: 'member',
    tenant: ok(tenant),
    retention: ok(retention),
    users: null,
    apiKeys: null,
    invites: null,
  };
}

function adminData(): AdminData {
  return {
    role: 'tenant_admin',
    tenant: ok(tenant),
    retention: ok(retention),
    users: ok([]),
    apiKeys: ok([]),
    invites: ok([]),
  };
}

describe('AdminDashboard — RBAC-reduced composition (no cross-section data leak)', () => {
  it('a member sees only workspace + retention; users and API keys are absent', () => {
    renderWithRole(
      'member',
      <AdminDashboard data={memberData()} executors={executors} onChanged={vi.fn()} />,
    );

    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Retention')).toBeInTheDocument();
    // privileged sections were never fetched server-side → not rendered at all
    expect(screen.queryByText('Users')).not.toBeInTheDocument();
    expect(screen.queryByText('API keys')).not.toBeInTheDocument();
  });

  it('a member sees retention read-only (no edit affordance)', () => {
    renderWithRole(
      'member',
      <AdminDashboard data={memberData()} executors={executors} onChanged={vi.fn()} />,
    );
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('a tenant_admin sees every section', () => {
    renderWithRole(
      'tenant_admin',
      <AdminDashboard data={adminData()} executors={executors} onChanged={vi.fn()} />,
    );
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Retention')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.getByText('API keys')).toBeInTheDocument();
  });
});
