import type { InviteCreatedResponse, InviteResponse } from '@logalot/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminOutcome } from '../../server/admin';
import { renderWithRole } from '../test-utils';
import { InvitesSection } from './invites-section';

const INVITE_URL = 'https://app.logalot.test/invite/accept?token=lginv_thisistheonetimeurl';

function invite(overrides: Partial<InviteResponse> = {}): InviteResponse {
  return {
    id: 'invite1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    email: 'alice@example.com',
    role: 'member',
    status: 'pending',
    expiresAt: '2026-07-30T00:00:00.000Z',
    createdBy: '00000000-0000-0000-0000-000000000001',
    consumedAt: null,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  };
}

const created: InviteCreatedResponse = { ...invite(), inviteUrl: INVITE_URL };
const ok = <T,>(data: T): AdminOutcome<T> => ({ ok: true, data });

function makeProps() {
  return {
    create: vi.fn(async (..._a: unknown[]) => ok(created)),
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

describe('InvitesSection — RBAC-reduced UI', () => {
  it('a member sees no invite or revoke controls (and the section can be hidden entirely)', () => {
    renderWithRole('member', <InvitesSection invites={[invite()]} {...makeProps()} />);
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });
});

describe('InvitesSection — create (link shown exactly once)', () => {
  it('submits a valid {email, role} and reveals the link once, then clears it on close', async () => {
    const u = userEvent.setup();
    const writeText = stubClipboard();
    const props = makeProps();
    renderWithRole('tenant_admin', <InvitesSection invites={[]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Email'), 'alice@example.com');
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));

    await waitFor(() =>
      expect(props.create).toHaveBeenCalledWith({
        email: 'alice@example.com',
        role: 'member',
      }),
    );

    // the link is revealed exactly once, with an explicit "won't see again" warning
    const link = (await screen.findByLabelText('Invite link')) as HTMLInputElement;
    expect(link.value).toBe(INVITE_URL);
    expect(screen.getByText(/won't be able to see this again/i)).toBeInTheDocument();
    expect(props.onChanged).toHaveBeenCalled();

    // copy puts ONLY the link on the clipboard
    await u.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INVITE_URL));

    // closing the reveal clears the link from the DOM (and from memory) and it does
    // not resurface after dismissal
    await u.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByLabelText('Invite link')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(INVITE_URL)).not.toBeInTheDocument();
  });

  it('sends the selected role (admin) in the create request', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <InvitesSection invites={[]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Email'), 'bob@example.com');
    await u.selectOptions(within(dialog).getByLabelText('Role'), 'admin');
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));

    await waitFor(() =>
      expect(props.create).toHaveBeenCalledWith({ email: 'bob@example.com', role: 'admin' }),
    );
  });

  it('surfaces a failed create and keeps the dialog open', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    props.create = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid' as const, message: 'An invite already exists for that email' },
    }));
    renderWithRole('tenant_admin', <InvitesSection invites={[]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Email'), 'dup@example.com');
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));

    expect(
      await within(dialog).findByText('An invite already exists for that email'),
    ).toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});

describe('InvitesSection — list', () => {
  it('shows status and expiry for each invite', () => {
    renderWithRole('tenant_admin', <InvitesSection invites={[invite()]} {...makeProps()} />);
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/expires 2026-07-30/)).toBeInTheDocument();
  });

  it('does not offer revoke for a consumed or already-revoked invite', () => {
    renderWithRole(
      'tenant_admin',
      <InvitesSection invites={[invite({ status: 'revoked' })]} {...makeProps()} />,
    );
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });
});

describe('InvitesSection — revoke', () => {
  it('revokes an invite after confirmation and refreshes the list', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    renderWithRole('tenant_admin', <InvitesSection invites={[invite()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Revoke invite' }));

    await waitFor(() => expect(props.revoke).toHaveBeenCalledWith('invite1'));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('surfaces a failed revoke and keeps the dialog open (no refresh)', async () => {
    const u = userEvent.setup();
    const props = makeProps();
    props.revoke = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid' as const, message: 'Invite already consumed' },
    }));
    renderWithRole('tenant_admin', <InvitesSection invites={[invite()]} {...props} />);

    await u.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Revoke invite' }));

    expect(await within(dialog).findByText('Invite already consumed')).toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});
