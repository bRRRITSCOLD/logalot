import {
  type RetentionResponse,
  type UpsertRetentionRequest,
  upsertRetentionRequestSchema,
} from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DialogFooter,
  TextField,
} from '../../components/ui';
import { useCan } from '../../hooks/use-can';
import type { AdminOutcome } from '../../server/admin';

export interface RetentionCardProps {
  retention: RetentionResponse | null;
  update: (body: UpsertRetentionRequest) => Promise<AdminOutcome<RetentionResponse>>;
  onChanged: () => void | Promise<void>;
}

export function RetentionCard({ retention, update, onChanged }: RetentionCardProps) {
  const can = useCan();
  const canEdit = can('retention:update');
  const [editing, setEditing] = React.useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Retention</CardTitle>
          <p className="text-fg-muted text-sm">
            How long logs stay in the hot store and cold archive.
          </p>
        </div>
        {canEdit && !editing ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {retention ? 'Edit' : 'Set policy'}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {editing ? (
          <RetentionForm
            retention={retention}
            update={update}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              setEditing(false);
              await onChanged();
            }}
          />
        ) : retention ? (
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div className="flex flex-col gap-0.5">
              <dt className="text-fg-muted">Hot store</dt>
              <dd className="font-medium text-fg-default">{retention.hotDays} days</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-fg-muted">Cold archive</dt>
              <dd className="font-medium text-fg-default">{retention.coldDays} days</dd>
            </div>
          </dl>
        ) : (
          <p className="text-fg-muted text-sm">
            No retention policy configured yet.
            {canEdit ? '' : ' A workspace admin can set one.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RetentionForm({
  retention,
  update,
  onCancel,
  onSaved,
}: {
  retention: RetentionResponse | null;
  update: RetentionCardProps['update'];
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      hotDays: String(retention?.hotDays ?? 30),
      coldDays: String(retention?.coldDays ?? 365),
    },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const parsed = upsertRetentionRequestSchema.safeParse({
        hotDays: Number(value.hotDays),
        coldDays: Number(value.coldDays),
      });
      if (!parsed.success) {
        setFormError(parsed.error.issues.map((i) => i.message).join('. '));
        return;
      }
      const outcome = await update(parsed.data);
      if (outcome.ok) await onSaved();
      else setFormError(outcome.error.message);
    },
  });

  return (
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
        <Alert tone="danger" title="Couldn't save retention">
          {formError}
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <form.Field name="hotDays">
          {(field) => (
            <TextField
              label="Hot store (days)"
              type="number"
              min={1}
              max={90}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          )}
        </form.Field>
        <form.Field name="coldDays">
          {(field) => (
            <TextField
              label="Cold archive (days)"
              type="number"
              min={1}
              max={36500}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          )}
        </form.Field>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save retention'}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}
