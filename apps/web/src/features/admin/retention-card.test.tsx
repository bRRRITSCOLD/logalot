import type { RetentionResponse } from '@logalot/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminOutcome } from '../../server/admin';
import { renderWithRole } from '../test-utils';
import { RetentionCard } from './retention-card';

const retention: RetentionResponse = {
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  hotDays: 30,
  coldDays: 365,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const ok = <T,>(data: T): AdminOutcome<T> => ({ ok: true, data });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RetentionCard — view', () => {
  it('shows the policy read-only to a member (no edit)', () => {
    renderWithRole(
      'member',
      <RetentionCard retention={retention} update={vi.fn()} onChanged={vi.fn()} />,
    );
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('365 days')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('prompts a tenant_admin to set a policy when none exists', () => {
    renderWithRole(
      'tenant_admin',
      <RetentionCard retention={null} update={vi.fn()} onChanged={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Set policy' })).toBeInTheDocument();
  });
});

describe('RetentionCard — edit (tenant_admin)', () => {
  it('saves an updated policy validated by the shared contract', async () => {
    const u = userEvent.setup();
    const update = vi.fn(async (..._a: unknown[]) => ok(retention));
    const onChanged = vi.fn();
    renderWithRole(
      'tenant_admin',
      <RetentionCard retention={retention} update={update} onChanged={onChanged} />,
    );

    await u.click(screen.getByRole('button', { name: 'Edit' }));
    const hot = screen.getByLabelText('Hot store (days)');
    await u.clear(hot);
    await u.type(hot, '45');
    await u.click(screen.getByRole('button', { name: 'Save retention' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toEqual({ hotDays: 45, coldDays: 365 });
    expect(onChanged).toHaveBeenCalled();
  });

  it('rejects coldDays < hotDays with the shared-contract refinement (no executor call)', async () => {
    const u = userEvent.setup();
    const update = vi.fn(async (..._a: unknown[]) => ok(retention));
    renderWithRole(
      'tenant_admin',
      <RetentionCard retention={retention} update={update} onChanged={vi.fn()} />,
    );

    await u.click(screen.getByRole('button', { name: 'Edit' }));
    const cold = screen.getByLabelText('Cold archive (days)');
    await u.clear(cold);
    await u.type(cold, '5'); // less than hotDays 30
    await u.click(screen.getByRole('button', { name: 'Save retention' }));

    expect(await screen.findByText(/coldDays must be >= hotDays/i)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});
