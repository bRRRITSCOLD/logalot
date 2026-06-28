import {
  type AlertComparator,
  type AlertRuleResponse,
  type AlertSeverity,
  alertComparatorSchema,
  alertSeveritySchema,
  type CreateAlertRuleRequest,
  createAlertRuleRequestSchema,
  type LogLevel,
  logLevelSchema,
  type UpdateAlertRuleRequest,
  updateAlertRuleRequestSchema,
} from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';
import {
  Alert,
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  DialogFooter,
  SelectField,
  TextField,
} from '../../components/ui';
import type { AdminOutcome } from '../../server/admin';

// ── Pure assembly + validation (exported for unit tests) ─────────────────────

export interface NotifyChannelDraft {
  type: 'webhook' | 'email';
  value: string;
}

export interface AlertRuleFormValues {
  name: string;
  text: string;
  service: string;
  level: '' | LogLevel;
  labels: string;
  comparator: AlertComparator;
  threshold: string;
  windowSeconds: string;
  severity: AlertSeverity;
  enabled: boolean;
  notifyChannels: NotifyChannelDraft[];
}

export const EMPTY_ALERT_RULE_VALUES: AlertRuleFormValues = {
  name: '',
  text: '',
  service: '',
  level: '',
  labels: '',
  comparator: 'gt',
  threshold: '0',
  windowSeconds: '300',
  severity: 'warning',
  enabled: true,
  notifyChannels: [],
};

/** Parse a `key=value` per-line textarea into a label record (blank lines ignored). */
export function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Assemble the request body from the heterogeneous form values (strings→numbers, etc.). */
export function assembleAlertRuleBody(values: AlertRuleFormValues): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (values.text.trim()) query.text = values.text.trim();
  if (values.service.trim()) query.service = values.service.trim();
  if (values.level) query.level = values.level;
  const labels = parseLabels(values.labels);
  if (Object.keys(labels).length > 0) query.labels = labels;

  const notifyChannels = values.notifyChannels
    .filter((c) => c.value.trim() !== '')
    .map((c) =>
      c.type === 'webhook'
        ? { type: 'webhook', url: c.value.trim() }
        : { type: 'email', to: c.value.trim() },
    );

  return {
    name: values.name.trim(),
    query,
    comparator: values.comparator,
    threshold: Number(values.threshold),
    windowSeconds: Number(values.windowSeconds),
    severity: values.severity,
    enabled: values.enabled,
    notifyChannels,
  };
}

/** Map an existing rule into editable form values. */
export function valuesFromRule(rule: AlertRuleResponse): AlertRuleFormValues {
  const severity = alertSeveritySchema.safeParse(rule.severity);
  return {
    name: rule.name,
    text: rule.query.text ?? '',
    service: rule.query.service ?? '',
    level: rule.query.level ?? '',
    labels: Object.entries(rule.query.labels ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    comparator: rule.comparator,
    threshold: String(rule.threshold),
    windowSeconds: String(rule.windowSeconds),
    severity: severity.success ? severity.data : 'warning',
    enabled: rule.enabled,
    notifyChannels: rule.notifyChannels.map((c) =>
      c.type === 'webhook' ? { type: 'webhook', value: c.url } : { type: 'email', value: c.to },
    ),
  };
}

/**
 * Validate the assembled body against the SHARED contract for the given mode and
 * return either the typed request or the collected user-facing issue messages.
 */
export function validateAlertRule(
  mode: 'create' | 'edit',
  values: AlertRuleFormValues,
):
  | { ok: true; create: CreateAlertRuleRequest }
  | { ok: true; update: UpdateAlertRuleRequest }
  | { ok: false; messages: string[] } {
  const body = assembleAlertRuleBody(values);
  const result =
    mode === 'create'
      ? createAlertRuleRequestSchema.safeParse(body)
      : updateAlertRuleRequestSchema.safeParse(body);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message);
    return { ok: false, messages: [...new Set(messages)] };
  }
  return mode === 'create'
    ? { ok: true, create: result.data as CreateAlertRuleRequest }
    : { ok: true, update: result.data as UpdateAlertRuleRequest };
}

// ── Dialog form ──────────────────────────────────────────────────────────────

const COMPARATOR_LABELS: Record<AlertComparator, string> = {
  gt: 'greater than (>)',
  gte: 'greater than or equal (≥)',
  lt: 'less than (<)',
  lte: 'less than or equal (≤)',
  eq: 'equal to (=)',
};

export interface AlertRuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  rule?: AlertRuleResponse;
  /** Wired by the page to createAlertRuleFn / updateAlertRuleFn. */
  submit: (
    body: CreateAlertRuleRequest | UpdateAlertRuleRequest,
  ) => Promise<AdminOutcome<AlertRuleResponse>>;
  onSaved: () => void;
}

const textareaClass =
  'min-h-16 w-full rounded-input border border-border-default bg-bg-inset px-2.5 py-1.5 text-base text-fg-default transition-colors placeholder:text-fg-subtle focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus';

export function AlertRuleFormDialog({
  open,
  onOpenChange,
  mode,
  rule,
  submit,
  onSaved,
}: AlertRuleFormDialogProps) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const labelsId = React.useId();

  const form = useForm({
    defaultValues: rule ? valuesFromRule(rule) : EMPTY_ALERT_RULE_VALUES,
    onSubmit: async ({ value }) => {
      setFormError(null);
      const validated = validateAlertRule(mode, value);
      if (!validated.ok) {
        setFormError(validated.messages.join('. '));
        return;
      }
      const body = 'create' in validated ? validated.create : validated.update;
      const outcome = await submit(body);
      if (outcome.ok) {
        onSaved();
        onOpenChange(false);
      } else {
        setFormError(outcome.error.message);
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={mode === 'create' ? 'New alert rule' : 'Edit alert rule'}
        description="Alerts evaluate a query over a rolling window and fire when the match count crosses your threshold."
        className="max-w-lg"
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
            <Alert tone="danger" title="Couldn't save the rule">
              {formError}
            </Alert>
          ) : null}

          <form.Field name="name">
            {(field) => (
              <TextField
                label="Name"
                placeholder="High error rate on api"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>

          <fieldset className="flex flex-col gap-3 rounded-card border border-border-subtle p-3">
            <legend className="px-1 font-medium text-fg-muted text-xs">Match query</legend>
            <form.Field name="text">
              {(field) => (
                <TextField
                  label="Text contains"
                  placeholder="timeout"
                  description="Full-text match within the log message."
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </form.Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <form.Field name="service">
                {(field) => (
                  <TextField
                    label="Service"
                    placeholder="api"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                )}
              </form.Field>
              <form.Field name="level">
                {(field) => (
                  <SelectField
                    label="Level"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value as '' | LogLevel)}
                  >
                    <option value="">Any level</option>
                    {logLevelSchema.options.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </SelectField>
                )}
              </form.Field>
            </div>
            <form.Field name="labels">
              {(field) => (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={labelsId} className="font-medium text-fg-default text-sm">
                    Labels
                  </label>
                  <textarea
                    id={labelsId}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={'env=prod\nregion=us-east-1'}
                    className={textareaClass}
                  />
                  <p className="text-fg-muted text-xs">One key=value per line.</p>
                </div>
              )}
            </form.Field>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <form.Field name="comparator">
              {(field) => (
                <SelectField
                  label="Comparator"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as AlertComparator)}
                >
                  {alertComparatorSchema.options.map((c) => (
                    <option key={c} value={c}>
                      {COMPARATOR_LABELS[c]}
                    </option>
                  ))}
                </SelectField>
              )}
            </form.Field>
            <form.Field name="threshold">
              {(field) => (
                <TextField
                  label="Threshold"
                  type="number"
                  min={0}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </form.Field>
            <form.Field name="windowSeconds">
              {(field) => (
                <TextField
                  label="Window (seconds)"
                  type="number"
                  min={30}
                  max={86400}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </form.Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <form.Field name="severity">
              {(field) => (
                <SelectField
                  label="Severity"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as AlertSeverity)}
                >
                  {alertSeveritySchema.options.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </SelectField>
              )}
            </form.Field>
            <form.Field name="enabled">
              {(field) => (
                <div className="flex items-end pb-1.5">
                  <CheckboxField
                    label="Enabled"
                    description="Disabled rules are not evaluated."
                    name={field.name}
                    checked={field.state.value}
                    onChange={(e) => field.handleChange(e.target.checked)}
                  />
                </div>
              )}
            </form.Field>
          </div>

          <form.Field name="notifyChannels" mode="array">
            {(field) => (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-fg-default text-sm">Notify channels</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => field.pushValue({ type: 'webhook', value: '' })}
                  >
                    Add channel
                  </Button>
                </div>
                {field.state.value.length === 0 ? (
                  <p className="text-fg-muted text-xs">
                    No channels — the rule still tracks state, just won't notify.
                  </p>
                ) : null}
                {field.state.value.map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and reorder-free
                  <div key={i} className="flex items-end gap-2">
                    <form.Field name={`notifyChannels[${i}].type`}>
                      {(sub) => (
                        <SelectField
                          label="Type"
                          rootClassName="w-32"
                          value={sub.state.value}
                          onChange={(e) => sub.handleChange(e.target.value as 'webhook' | 'email')}
                        >
                          <option value="webhook">Webhook</option>
                          <option value="email">Email</option>
                        </SelectField>
                      )}
                    </form.Field>
                    <form.Field name={`notifyChannels[${i}].value`}>
                      {(sub) => (
                        <TextField
                          label="Destination"
                          rootClassName="flex-1"
                          placeholder="https://hooks.example.com/… or alerts@acme.test"
                          value={sub.state.value}
                          onChange={(e) => sub.handleChange(e.target.value)}
                        />
                      )}
                    </form.Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove channel ${i + 1}`}
                      onClick={() => field.removeValue(i)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </form.Field>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Saving…' : mode === 'create' ? 'Create rule' : 'Save changes'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
