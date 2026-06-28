import type { ApiKeyCreatedResponse, ApiKeyResponse } from '@logalot/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminOutcome } from '../../server/admin';
import { renderWithRole } from '../test-utils';
import { ApiKeysSection } from './api-keys-section';

const SECRET = 'lgk_acme_key1_thisisthesecretshownonce';

function key(overrides: Partial<ApiKeyResponse> = {}): ApiKeyResponse {
  return {
    id: 'key1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: 'prod ingest',
    scopes: ['ingest:write'],
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

const created: ApiKeyCreatedResponse = { ...key(), plaintext: SECRET };
const ok = <T,>(data: T): AdminOutcome<T> => ({ ok: true, data });

function makeProps() {
  return {
    issue: vi.fn(async (..._a: unknown[]) => ok(created)),
    revoke: vi.fn(async (..._a: unknown[]) => ok(undefined)),
    onChanged: vi.fn(),
  };
}

/** Install a clipboard spy AFTER userEvent.setup() (which installs its own stub). */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiKeysSection — RBAC-reduced UI', () => {
  it('a member sees no issue or revoke controls', () => {
    renderWithRole('member', <ApiKeysSection apiKeys={[key()]} {...makeProps()} />);
    expect(screen.queryByRole('button', { name: 'Issue key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });
});

describe('ApiKeysSection — issue (secret shown exactly once)', () => {
  it('reveals the plaintext once with a warning + copy, then clears it on close', async () => {
    const u = userEvent.setup();
    const writeText = stubClipboard();
    const props = makeProps();
    renderWithRole('tenant_admin', <ApiKeysSection apiKeys={[]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Issue key' }));
    const issueDialog = await screen.findByRole('dialog');
    await u.type(within(issueDialog).getByLabelText('Name'), 'prod ingest');
    await u.click(within(issueDialog).getByRole('button', { name: 'Issue key' }));

    // the secret is revealed exactly once, with an explicit "won't see again" warning
    const secret = (await screen.findByLabelText('API key secret')) as HTMLInputElement;
    expect(secret.value).toBe(SECRET);
    expect(screen.getByText(/won't be able to see this again/i)).toBeInTheDocument();
    expect(props.onChanged).toHaveBeenCalled();

    // copy puts ONLY the secret on the clipboard
    await u.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));

    // closing the reveal clears the secret from the DOM (and from memory)
    await u.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByLabelText('API key secret')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
  });
});

describe('ApiKeysSection — scope selector', () => {
  it('defaults to ingest:write checked and logs:read unchecked', async () => {
    const u = userEvent.setup();
    renderWithRole('tenant_admin', <ApiKeysSection apiKeys={[]} {...makeProps()} />);

    await u.click(screen.getByRole('button', { name: 'Issue key' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('checkbox', { name: /ingest:write/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /logs:read/ })).not.toBeChecked();
  });

  it('sends the selected scopes in the create request', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <ApiKeysSection apiKeys={[]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Issue key' }));
    const dialog = await screen.findByRole('dialog');

    await u.type(within(dialog).getByLabelText('Name'), 'read-only key');
    // uncheck ingest:write, check logs:read
    await u.click(within(dialog).getByRole('checkbox', { name: /ingest:write/ }));
    await u.click(within(dialog).getByRole('checkbox', { name: /logs:read/ }));
    await u.click(within(dialog).getByRole('button', { name: 'Issue key' }));

    await waitFor(() => expect(props.issue).toHaveBeenCalled());
    const [body] = props.issue.mock.calls[0] as [{ name: string; scopes: string[] }];
    expect(body.scopes).toEqual(['logs:read']);
  });

  it('blocks submit when no scopes are selected and shows an error', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <ApiKeysSection apiKeys={[]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Issue key' }));
    const dialog = await screen.findByRole('dialog');

    await u.type(within(dialog).getByLabelText('Name'), 'empty-scope key');
    // uncheck the default ingest:write so nothing is selected
    await u.click(within(dialog).getByRole('checkbox', { name: /ingest:write/ }));
    await u.click(within(dialog).getByRole('button', { name: 'Issue key' }));

    expect(await within(dialog).findByText(/at least one scope is required/i)).toBeInTheDocument();
    expect(props.issue).not.toHaveBeenCalled();
  });

  it('allows both scopes to be selected together', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <ApiKeysSection apiKeys={[]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Issue key' }));
    const dialog = await screen.findByRole('dialog');

    await u.type(within(dialog).getByLabelText('Name'), 'full-access key');
    await u.click(within(dialog).getByRole('checkbox', { name: /logs:read/ }));
    await u.click(within(dialog).getByRole('button', { name: 'Issue key' }));

    await waitFor(() => expect(props.issue).toHaveBeenCalled());
    const [body] = props.issue.mock.calls[0] as [{ name: string; scopes: string[] }];
    expect(body.scopes).toContain('ingest:write');
    expect(body.scopes).toContain('logs:read');
  });

  it('surfaces scopes on each key in the list', () => {
    renderWithRole(
      'tenant_admin',
      <ApiKeysSection apiKeys={[key({ scopes: ['logs:read'] })]} {...makeProps()} />,
    );
    expect(screen.getByText(/logs:read/)).toBeInTheDocument();
  });
});

describe('ApiKeysSection — revoke', () => {
  it('revokes a key after confirmation and refreshes', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <ApiKeysSection apiKeys={[key()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => expect(props.revoke).toHaveBeenCalledWith('key1'));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('surfaces a failed revoke and keeps the dialog open (no refresh)', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    props.revoke = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid' as const, message: 'Key is still in use' },
    }));
    renderWithRole('tenant_admin', <ApiKeysSection apiKeys={[key()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Revoke key' }));

    expect(await within(dialog).findByText('Key is still in use')).toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
    // the confirm dialog stays open so the user can retry or cancel
    expect(within(dialog).getByRole('button', { name: 'Revoke key' })).toBeInTheDocument();
  });

  it('does not offer revoke for an already-revoked key', () => {
    renderWithRole(
      'tenant_admin',
      <ApiKeysSection apiKeys={[key({ revokedAt: '2026-02-01T00:00:00Z' })]} {...makeProps()} />,
    );
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });
});
