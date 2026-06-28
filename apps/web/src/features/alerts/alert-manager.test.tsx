import type { AlertRuleResponse } from '@logalot/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminOutcome } from '../../server/admin';
import { renderWithRole } from '../test-utils';
import { AlertManager } from './alert-manager';

function rule(overrides: Partial<AlertRuleResponse> = {}): AlertRuleResponse {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: 'High error rate',
    savedQueryId: null,
    query: { text: 'boom', service: 'api' },
    comparator: 'gt',
    threshold: 10,
    windowSeconds: 300,
    severity: 'critical',
    enabled: true,
    notifyChannels: [],
    state: 'ok',
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const ok = <T,>(data: T): AdminOutcome<T> => ({ ok: true, data });

function makeProps() {
  return {
    create: vi.fn(async (..._a: unknown[]) => ok(rule())),
    update: vi.fn(async (..._a: unknown[]) => ok(rule())),
    remove: vi.fn(async (..._a: unknown[]) => ok(undefined)),
    onChanged: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AlertManager — RBAC-reduced UI (display-only mirror)', () => {
  it('a member sees alert state but NO create/edit/delete affordances', () => {
    const props = makeProps();
    renderWithRole('member', <AlertManager rules={[rule({ state: 'firing' })]} {...props} />);

    // state is visible to a member
    expect(screen.getByLabelText('Alert state: Firing')).toBeInTheDocument();
    // …but no write actions
    expect(screen.queryByRole('button', { name: 'New rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('a tenant_admin sees the full write surface', () => {
    const props = makeProps();
    renderWithRole('tenant_admin', <AlertManager rules={[rule()]} {...props} />);
    expect(screen.getByRole('button', { name: 'New rule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('disables Edit for a saved-query-backed rule with an explanation', () => {
    renderWithRole(
      'tenant_admin',
      <AlertManager
        rules={[rule({ savedQueryId: '00000000-0000-0000-0000-0000000000d9', query: {} })]}
        {...makeProps()}
      />,
    );
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', expect.stringContaining('Saved-query-backed'));
  });
});

describe('AlertManager — alert state display', () => {
  it('renders firing / ok / paused states distinctly', () => {
    renderWithRole(
      'member',
      <AlertManager
        rules={[
          rule({ id: 'a', name: 'A', state: 'firing', enabled: true }),
          rule({ id: 'b', name: 'B', state: 'ok', enabled: true }),
          rule({ id: 'c', name: 'C', state: 'firing', enabled: false }),
        ]}
        {...makeProps()}
      />,
    );
    expect(screen.getByText('Firing')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    // a disabled rule reads as Paused regardless of last state
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });
});

describe('AlertManager — create / delete (tenant_admin)', () => {
  it('creates a rule from an inline query and refreshes', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <AlertManager rules={[rule()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Name'), 'Latency spike');
    await u.type(within(dialog).getByLabelText('Text contains'), 'timeout');
    await u.click(within(dialog).getByRole('button', { name: 'Create rule' }));

    await waitFor(() => expect(props.create).toHaveBeenCalledTimes(1));
    const body = props.create.mock.calls[0]?.[0] as { name: string; query: { text: string } };
    expect(body.name).toBe('Latency spike');
    expect(body.query.text).toBe('timeout');
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('blocks an empty inline query with the shared-contract message (no executor call)', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <AlertManager rules={[rule()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Name'), 'Bad rule');
    await u.click(within(dialog).getByRole('button', { name: 'Create rule' }));

    expect(await within(dialog).findByText(/exactly one of/i)).toBeInTheDocument();
    expect(props.create).not.toHaveBeenCalled();
  });

  it('edits a rule, sending a patch to the matching id', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <AlertManager rules={[rule()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await u.clear(name);
    await u.type(name, 'Renamed rule');
    await u.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(props.update).toHaveBeenCalledTimes(1));
    expect(props.update.mock.calls[0]?.[0]).toBe(rule().id);
    const patch = props.update.mock.calls[0]?.[1] as { name: string };
    expect(patch.name).toBe('Renamed rule');
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('deletes a rule after confirmation', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <AlertManager rules={[rule()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Delete rule' }));

    await waitFor(() => expect(props.remove).toHaveBeenCalledWith(rule().id));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('surfaces a failed delete and does not refresh', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    props.remove = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid' as const, message: 'Rule is still referenced' },
    }));
    renderWithRole('tenant_admin', <AlertManager rules={[rule()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Delete rule' }));

    expect(await within(dialog).findByText('Rule is still referenced')).toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});
