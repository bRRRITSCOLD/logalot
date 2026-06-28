import {
  type ApiKeyCreatedResponse,
  type ApiKeyResponse,
  type CreateApiKeyRequest,
  createApiKeyRequestSchema,
  type Scope,
  scopeSchema,
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
  CheckboxField,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  TextField,
} from '../../components/ui';
import { useCan } from '../../hooks/use-can';
import type { AdminOutcome } from '../../server/admin';

export interface ApiKeysSectionProps {
  apiKeys: ApiKeyResponse[];
  issue: (body: CreateApiKeyRequest) => Promise<AdminOutcome<ApiKeyCreatedResponse>>;
  revoke: (id: string) => Promise<AdminOutcome<void>>;
  onChanged: () => void | Promise<void>;
}

function statusOf(key: ApiKeyResponse): { label: string; tone: 'success' | 'neutral' | 'warning' } {
  if (key.revokedAt) return { label: 'Revoked', tone: 'neutral' };
  if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) {
    return { label: 'Expired', tone: 'warning' };
  }
  return { label: 'Active', tone: 'success' };
}

export function ApiKeysSection({ apiKeys, issue, revoke, onChanged }: ApiKeysSectionProps) {
  const can = useCan();
  const canCreate = can('apikey:create');
  const canRevoke = can('apikey:revoke');

  const [issuing, setIssuing] = React.useState(false);
  // The one-time plaintext secret. Held in state ONLY while the reveal modal is
  // open and cleared the moment it closes; never logged, never persisted, never
  // sent anywhere. This is the single in-memory home of the secret.
  const [issued, setIssued] = React.useState<ApiKeyCreatedResponse | null>(null);
  const [revoking, setRevoking] = React.useState<ApiKeyResponse | null>(null);
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
          <CardTitle>API keys</CardTitle>
          <p className="text-fg-muted text-sm">
            Ingest credentials for sending logs to this tenant.
          </p>
        </div>
        {canCreate ? (
          <Button size="sm" onClick={() => setIssuing(true)}>
            Issue key
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {apiKeys.length === 0 ? (
          <EmptyState
            title="No API keys"
            description={canCreate ? 'Issue a key to start ingesting logs.' : undefined}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {apiKeys.map((key) => {
              const status = statusOf(key);
              return (
                <li key={key.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-fg-default text-sm">
                        {key.name}
                      </span>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <span className="text-fg-muted text-xs">
                      {key.scopes.join(', ')} · created {key.createdAt.slice(0, 10)}
                      {key.lastUsedAt
                        ? ` · last used ${key.lastUsedAt.slice(0, 10)}`
                        : ' · never used'}
                    </span>
                  </div>
                  {canRevoke && !key.revokedAt ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(key);
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

      {issuing ? (
        <IssueKeyDialog
          issue={issue}
          onClose={() => setIssuing(false)}
          onIssued={async (created) => {
            setIssuing(false);
            setIssued(created); // reveal the secret once
            await onChanged(); // refresh the list (metadata only)
          }}
        />
      ) : null}

      {issued ? (
        <SecretRevealDialog
          created={issued}
          onClose={() => setIssued(null) /* clears the plaintext from memory */}
        />
      ) : null}

      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <DialogContent
          title="Revoke API key"
          description={
            revoking
              ? `“${revoking.name}” will stop working immediately. Any client using it will be rejected.`
              : ''
          }
        >
          {revokeError ? (
            <Alert tone="danger" title="Couldn't revoke the key">
              {revokeError}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={revokeBusy} onClick={onRevoke}>
              {revokeBusy ? 'Revoking…' : 'Revoke key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Human-readable labels for each scope value. Derived from scopeSchema.options. */
const SCOPE_OPTIONS: ReadonlyArray<{ value: Scope; label: string; description: string }> =
  scopeSchema.options.map((s) => {
    if (s === 'ingest:write') {
      return { value: s, label: 'ingest:write', description: 'Send logs to this tenant.' };
    }
    return { value: s, label: 'logs:read', description: 'Read logs, search, and live-tail.' };
  });

function IssueKeyDialog({
  issue,
  onClose,
  onIssued,
}: {
  issue: ApiKeysSectionProps['issue'];
  onClose: () => void;
  onIssued: (created: ApiKeyCreatedResponse) => void | Promise<void>;
}) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: { name: '', expiresAt: '', scopes: ['ingest:write'] as Scope[] },
    onSubmit: async ({ value }) => {
      setFormError(null);
      if (value.scopes.length === 0) {
        setFormError('At least one scope is required.');
        return;
      }
      const body: Record<string, unknown> = {
        name: value.name.trim(),
        scopes: value.scopes,
      };
      if (value.expiresAt) {
        const ms = new Date(value.expiresAt).getTime();
        if (Number.isNaN(ms)) {
          setFormError('Expiry is not a valid date.');
          return;
        }
        body.expiresAt = new Date(ms).toISOString();
      }
      const parsed = createApiKeyRequestSchema.safeParse(body);
      if (!parsed.success) {
        setFormError(parsed.error.issues.map((i) => i.message).join('. '));
        return;
      }
      const outcome = await issue(parsed.data);
      if (outcome.ok) {
        await onIssued(outcome.data);
      } else {
        setFormError(outcome.error.message);
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Issue API key"
        description="The secret is shown once and cannot be retrieved later."
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
            <Alert tone="danger" title="Couldn't issue the key">
              {formError}
            </Alert>
          ) : null}
          <form.Field name="name">
            {(field) => (
              <TextField
                label="Name"
                placeholder="prod ingest"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="expiresAt">
            {(field) => (
              <TextField
                label="Expires (optional)"
                type="datetime-local"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="scopes">
            {(field) => (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium text-fg-default text-sm">Scopes</legend>
                {SCOPE_OPTIONS.map((opt) => (
                  <CheckboxField
                    key={opt.value}
                    label={opt.label}
                    description={opt.description}
                    checked={field.state.value.includes(opt.value)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...field.state.value, opt.value]
                        : field.state.value.filter((s) => s !== opt.value);
                      field.handleChange(next);
                    }}
                  />
                ))}
              </fieldset>
            )}
          </form.Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Issuing…' : 'Issue key'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretRevealDialog({
  created,
  onClose,
}: {
  created: ApiKeyCreatedResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context / permissions): the secret is still
      // selectable on screen. Never log the secret on failure.
      setCopied(false);
    }
  }, [created.plaintext]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title="Copy your API key now" description={`Secret for “${created.name}”.`}>
        <Alert tone="warning" title="You won't be able to see this again">
          Store it somewhere safe. If you lose it, revoke this key and issue a new one.
        </Alert>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            aria-label="API key secret"
            value={created.plaintext}
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
