import {
  type CreateInviteRequest,
  createInviteRequestSchema,
  type InviteCreatedResponse,
  type InviteResponse,
} from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';
import { EmptyState } from '../../components/states';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  SelectField,
  TextField,
} from '../../components/ui';
import { useCan } from '../../hooks/use-can';
import type { AdminOutcome } from '../../server/admin';

export interface InvitesSectionProps {
  invites: InviteResponse[];
  create: (body: CreateInviteRequest) => Promise<AdminOutcome<InviteCreatedResponse>>;
  revoke: (id: string) => Promise<AdminOutcome<void>>;
  onChanged: () => void | Promise<void>;
}

// Mirrors createInviteRequestSchema's `role` enum (member | admin) — hardcoded
// here rather than derived because the schema wraps it in `.default(...)`.
const ROLE_OPTIONS = [
  { value: 'member', label: 'member' },
  { value: 'admin', label: 'admin' },
] as const;

function statusOf(invite: InviteResponse): {
  label: string;
  tone: 'success' | 'neutral' | 'warning';
} {
  if (invite.status === 'revoked') return { label: 'Revoked', tone: 'neutral' };
  if (invite.status === 'consumed') return { label: 'Consumed', tone: 'success' };
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return { label: 'Expired', tone: 'warning' };
  }
  return { label: 'Pending', tone: 'success' };
}

export function InvitesSection({ invites, create, revoke, onChanged }: InvitesSectionProps) {
  const can = useCan();
  const canCreate = can('invite:create');
  const canRevoke = can('invite:revoke');

  const [inviting, setInviting] = React.useState(false);
  // The one-time invite URL (embeds the plaintext token). Held in state ONLY while
  // the reveal modal is open and cleared the moment it closes; never logged, never
  // persisted (R-INV-12). Mirrors the API-key secret-reveal pattern.
  const [created, setCreated] = React.useState<InviteCreatedResponse | null>(null);
  const [revoking, setRevoking] = React.useState<InviteResponse | null>(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  const [revokeError, setRevokeError] = React.useState<string | null>(null);

  const onRevoke = React.useCallback(async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeError(null);
    const outcome = await revoke(revoking.id);
    setRevokeBusy(false);
    if (outcome.ok) {
      setRevoking(null);
      await onChanged();
    } else {
      setRevokeError(outcome.error.message);
    }
  }, [revoking, revoke, onChanged]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Invites</CardTitle>
          <p className="text-fg-muted text-sm">Invite people to join this workspace.</p>
        </div>
        {canCreate ? (
          <Button size="sm" onClick={() => setInviting(true)}>
            Invite
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {invites.length === 0 ? (
          <EmptyState
            title="No invites"
            description={canCreate ? 'Invite someone to get them started.' : undefined}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {invites.map((invite) => {
              const status = statusOf(invite);
              return (
                <li key={invite.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-fg-default text-sm">
                        {invite.email}
                      </span>
                      <Badge tone="brand">{invite.role}</Badge>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <span className="text-fg-muted text-xs">
                      expires {invite.expiresAt.slice(0, 10)}
                    </span>
                  </div>
                  {canRevoke && invite.status === 'pending' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(invite);
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {inviting ? (
        <CreateInviteDialog
          create={create}
          onClose={() => setInviting(false)}
          onCreated={async (invite) => {
            setInviting(false);
            setCreated(invite); // reveal the invite link once
            await onChanged(); // refresh the list (metadata only)
          }}
        />
      ) : null}

      {created ? (
        <InviteLinkDialog
          created={created}
          onClose={() => setCreated(null) /* clears the link from memory */}
        />
      ) : null}

      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <DialogContent
          title="Revoke invite"
          description={
            revoking ? `The invite to “${revoking.email}” will no longer be usable.` : ''
          }
        >
          {revokeError ? (
            <Alert tone="danger" title="Couldn't revoke the invite">
              {revokeError}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={revokeBusy} onClick={onRevoke}>
              {revokeBusy ? 'Revoking…' : 'Revoke invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CreateInviteDialog({
  create,
  onClose,
  onCreated,
}: {
  create: InvitesSectionProps['create'];
  onClose: () => void;
  onCreated: (created: InviteCreatedResponse) => void | Promise<void>;
}) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { email: '', role: 'member' as 'member' | 'admin' },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const body = { email: value.email.trim(), role: value.role };
      const parsed = createInviteRequestSchema.safeParse(body);
      if (!parsed.success) {
        setFormError(parsed.error.issues.map((i) => i.message).join('. '));
        return;
      }
      const outcome = await create(parsed.data);
      if (outcome.ok) {
        await onCreated(outcome.data);
      } else {
        setFormError(outcome.error.message);
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Invite someone"
        description="They'll receive a one-time link (also shown here) to join this workspace."
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-4"
        >
          {formError ? (
            <Alert tone="danger" title="Couldn't send the invite">
              {formError}
            </Alert>
          ) : null}
          <form.Field name="email">
            {(field) => (
              <TextField
                label="Email"
                type="email"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="role">
            {(field) => (
              <SelectField
                label="Role"
                options={[...ROLE_OPTIONS]}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value as 'member' | 'admin')}
              />
            )}
          </form.Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Sending…' : 'Send invite'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InviteLinkDialog({
  created,
  onClose,
}: {
  created: InviteCreatedResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context / permissions): the link is still
      // selectable on screen. Never log the link (it embeds the plaintext token).
      setCopied(false);
    }
  }, [created.inviteUrl]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title="Copy the invite link now" description={`Link for “${created.email}”.`}>
        <Alert tone="warning" title="You won't be able to see this again">
          Share it with {created.email}. If it's lost, revoke this invite and send a new one.
        </Alert>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            aria-label="Invite link"
            value={created.inviteUrl}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button type="button" variant="secondary" size="sm" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
