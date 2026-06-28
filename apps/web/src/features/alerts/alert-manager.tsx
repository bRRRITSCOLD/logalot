import type {
  AlertRuleResponse,
  CreateAlertRuleRequest,
  RuleQuery,
  UpdateAlertRuleRequest,
} from '@logalot/contracts';
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
} from '../../components/ui';
import { useCan } from '../../hooks/use-can';
import type { AdminOutcome } from '../../server/admin';
import { AlertRuleFormDialog } from './alert-rule-form';
import { AlertStateBadge } from './alert-state-badge';

/** Human-readable one-line summary of a rule's match query. */
export function summarizeQuery(query: RuleQuery, savedQueryId: string | null): string {
  if (savedQueryId) return `Saved query ${savedQueryId.slice(0, 8)}…`;
  const parts: string[] = [];
  if (query.text) parts.push(`text:"${query.text}"`);
  if (query.service) parts.push(`service:${query.service}`);
  if (query.level) parts.push(`level:${query.level}`);
  for (const [k, v] of Object.entries(query.labels ?? {})) parts.push(`${k}=${v}`);
  return parts.length > 0 ? parts.join('  ') : 'all logs';
}

const COMPARATOR_SYMBOL: Record<string, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
};

export interface AlertManagerProps {
  rules: AlertRuleResponse[];
  create: (body: CreateAlertRuleRequest) => Promise<AdminOutcome<AlertRuleResponse>>;
  update: (id: string, patch: UpdateAlertRuleRequest) => Promise<AdminOutcome<AlertRuleResponse>>;
  remove: (id: string) => Promise<AdminOutcome<void>>;
  /** Re-run the loader after a successful mutation (router.invalidate in the route). */
  onChanged: () => void | Promise<void>;
}

type DialogState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; rule: AlertRuleResponse };

export function AlertManager({ rules, create, update, remove, onChanged }: AlertManagerProps) {
  const can = useCan();
  const canCreate = can('alert:create');
  const canUpdate = can('alert:update');
  const canDelete = can('alert:delete');

  const [dialog, setDialog] = React.useState<DialogState>({ kind: 'closed' });
  const [deleting, setDeleting] = React.useState<AlertRuleResponse | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const submit = React.useCallback(
    (body: CreateAlertRuleRequest | UpdateAlertRuleRequest) =>
      dialog.kind === 'edit'
        ? update(dialog.rule.id, body as UpdateAlertRuleRequest)
        : create(body as CreateAlertRuleRequest),
    [dialog, create, update],
  );

  const onDelete = React.useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const outcome = await remove(deleting.id);
    setDeleteBusy(false);
    if (outcome.ok) {
      setDeleting(null);
      await onChanged();
    } else {
      setDeleteError(outcome.error.message);
    }
  }, [deleting, remove, onChanged]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-fg-muted text-sm">
          {rules.length} alert {rules.length === 1 ? 'rule' : 'rules'}
        </p>
        {canCreate ? (
          <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
            New rule
          </Button>
        ) : null}
      </div>

      {rules.length === 0 ? (
        <EmptyState
          title="No alert rules yet"
          description={
            canCreate
              ? 'Create a rule to start watching your logs for conditions that matter.'
              : 'A workspace admin can create alert rules.'
          }
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
                New rule
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {rules.map((rule) => (
            <li key={rule.id}>
              <Card>
                <CardHeader className="flex-row items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{rule.name}</CardTitle>
                      <AlertStateBadge state={rule.state} enabled={rule.enabled} />
                      <Badge tone="neutral">{rule.severity}</Badge>
                    </div>
                    <code className="truncate font-mono text-fg-muted text-xs">
                      {summarizeQuery(rule.query, rule.savedQueryId)}
                    </code>
                  </div>
                  {canUpdate || canDelete ? (
                    <div className="flex shrink-0 gap-1">
                      {canUpdate ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setDialog({ kind: 'edit', rule })}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {canDelete ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleting(rule);
                          }}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-fg-muted text-sm">
                  <span>
                    Fires when count {COMPARATOR_SYMBOL[rule.comparator] ?? rule.comparator}{' '}
                    <span className="text-fg-default">{rule.threshold}</span> over{' '}
                    <span className="text-fg-default">{rule.windowSeconds}s</span>
                  </span>
                  <span>
                    {rule.notifyChannels.length}{' '}
                    {rule.notifyChannels.length === 1 ? 'channel' : 'channels'}
                  </span>
                  {rule.lastTriggeredAt ? <span>Last fired {rule.lastTriggeredAt}</span> : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {dialog.kind !== 'closed' ? (
        <AlertRuleFormDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: 'closed' });
          }}
          mode={dialog.kind}
          rule={dialog.kind === 'edit' ? dialog.rule : undefined}
          submit={submit}
          onSaved={onChanged}
        />
      ) : null}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent
          title="Delete alert rule"
          description={
            deleting ? `“${deleting.name}” will stop being evaluated. This cannot be undone.` : ''
          }
        >
          {deleteError ? (
            <Alert tone="danger" title="Couldn't delete the rule">
              {deleteError}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={deleteBusy} onClick={onDelete}>
              {deleteBusy ? 'Deleting…' : 'Delete rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
