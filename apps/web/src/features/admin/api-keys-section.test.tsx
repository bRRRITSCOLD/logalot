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

  it('does not offer revoke for an already-revoked key', () => {
    renderWithRole(
      'tenant_admin',
      <ApiKeysSection apiKeys={[key({ revokedAt: '2026-02-01T00:00:00Z' })]} {...makeProps()} />,
    );
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });
});
