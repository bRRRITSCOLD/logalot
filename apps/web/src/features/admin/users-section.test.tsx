import type { UserResponse } from '@logalot/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminOutcome } from '../../server/admin';
import { renderWithRole } from '../test-utils';
import { UsersSection } from './users-section';

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: '00000000-0000-0000-0000-0000000000c1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    email: 'ada@acme.test',
    displayName: 'Ada',
    status: 'active',
    role: 'member',
    isPlatformOperator: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const ok = <T,>(data: T): AdminOutcome<T> => ({ ok: true, data });

function makeProps() {
  return {
    create: vi.fn(async (..._a: unknown[]) => ok(user())),
    update: vi.fn(async (..._a: unknown[]) => ok(user())),
    remove: vi.fn(async (..._a: unknown[]) => ok(undefined)),
    onChanged: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UsersSection — RBAC-reduced UI', () => {
  it('a member sees no add / edit / remove controls', () => {
    renderWithRole('member', <UsersSection users={[user()]} {...makeProps()} />);
    expect(screen.queryByRole('button', { name: 'Add user' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});

describe('UsersSection — create (tenant_admin)', () => {
  it('creates a user with the chosen role and refreshes', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <UsersSection users={[user()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Add user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Email'), 'grace@acme.test');
    await u.type(within(dialog).getByLabelText('Temporary password'), 'hunter2hunter2');
    await u.selectOptions(within(dialog).getByLabelText('Role'), 'tenant_admin');
    await u.click(within(dialog).getByRole('button', { name: 'Add user' }));

    await waitFor(() => expect(props.create).toHaveBeenCalledTimes(1));
    const body = props.create.mock.calls[0]?.[0] as { email: string; role: string };
    expect(body.email).toBe('grace@acme.test');
    expect(body.role).toBe('tenant_admin');
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('blocks a too-short password with the shared-contract rule (no executor call)', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <UsersSection users={[user()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Add user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Email'), 'grace@acme.test');
    await u.type(within(dialog).getByLabelText('Temporary password'), 'short');
    await u.click(within(dialog).getByRole('button', { name: 'Add user' }));

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(props.create).not.toHaveBeenCalled();
  });
});

describe('UsersSection — edit (tenant_admin)', () => {
  it('sends a patch of only the changed fields and refreshes', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <UsersSection users={[user()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    // user fixture is active/member; suspend it and leave the rest untouched
    await u.selectOptions(within(dialog).getByLabelText('Status'), 'suspended');
    await u.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(props.update).toHaveBeenCalledTimes(1));
    expect(props.update.mock.calls[0]?.[0]).toBe(user().id);
    expect(props.update.mock.calls[0]?.[1]).toEqual({ status: 'suspended' });
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('surfaces a failed update and does not refresh', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    props.update = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid' as const, message: 'Email already exists' },
    }));
    renderWithRole('tenant_admin', <UsersSection users={[user()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    await u.selectOptions(within(dialog).getByLabelText('Role'), 'tenant_admin');
    await u.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByText('Email already exists')).toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});
