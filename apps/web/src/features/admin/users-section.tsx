import {
  type CreateUserRequest,
  createUserRequestSchema,
  membershipRoleSchema,
  type UpdateUserRequest,
  type UserResponse,
  updateUserRequestSchema,
  userStatusSchema,
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
  SelectField,
  TextField,
} from '../../components/ui';
import { useCan } from '../../hooks/use-can';
import type { AdminOutcome } from '../../server/admin';

export interface UsersSectionProps {
  users: UserResponse[];
  create: (body: CreateUserRequest) => Promise<AdminOutcome<UserResponse>>;
  update: (id: string, patch: UpdateUserRequest) => Promise<AdminOutcome<UserResponse>>;
  remove: (id: string) => Promise<AdminOutcome<void>>;
  onChanged: () => void | Promise<void>;
}

const roleOptions = membershipRoleSchema.options.map((r) => ({ value: r, label: r }));
const statusOptions = userStatusSchema.options.map((s) => ({ value: s, label: s }));

type DialogState = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; user: UserResponse };

export function UsersSection({ users, create, update, remove, onChanged }: UsersSectionProps) {
  const can = useCan();
  const canCreate = can('user:create');
  const canUpdate = can('user:update');
  const canDelete = can('user:delete');

  const [dialog, setDialog] = React.useState<DialogState>({ kind: 'closed' });
  const [deleting, setDeleting] = React.useState<UserResponse | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

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
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Users</CardTitle>
          <p className="text-fg-muted text-sm">People who can sign in to this workspace.</p>
        </div>
        {canCreate ? (
          <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
            Add user
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <EmptyState title="No users" />
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {users.map((user) => (
              <li key={user.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-fg-default text-sm">
                      {user.displayName ?? user.email}
                    </span>
                    <Badge tone="brand">{user.role}</Badge>
                    <Badge tone={user.status === 'active' ? 'success' : 'warning'}>
                      {user.status}
                    </Badge>
                  </div>
                  <span className="truncate text-fg-muted text-xs">{user.email}</span>
                </div>
                {canUpdate || canDelete ? (
                  <div className="flex shrink-0 gap-1">
                    {canUpdate ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDialog({ kind: 'edit', user })}
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
                          setDeleting(user);
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {dialog.kind === 'create' ? (
        <CreateUserDialog
          create={create}
          onClose={() => setDialog({ kind: 'closed' })}
          onSaved={async () => {
            setDialog({ kind: 'closed' });
            await onChanged();
          }}
        />
      ) : null}

      {dialog.kind === 'edit' ? (
        <EditUserDialog
          user={dialog.user}
          update={update}
          onClose={() => setDialog({ kind: 'closed' })}
          onSaved={async () => {
            setDialog({ kind: 'closed' });
            await onChanged();
          }}
        />
      ) : null}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent
          title="Remove user"
          description={deleting ? `${deleting.email} will lose access to this workspace.` : ''}
        >
          {deleteError ? (
            <Alert tone="danger" title="Couldn't remove the user">
              {deleteError}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={deleteBusy} onClick={onDelete}>
              {deleteBusy ? 'Removing…' : 'Remove user'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CreateUserDialog({
  create,
  onClose,
  onSaved,
}: {
  create: UsersSectionProps['create'];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      email: '',
      password: '',
      displayName: '',
      role: 'member' as 'tenant_admin' | 'member',
    },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const body: Record<string, unknown> = {
        email: value.email.trim(),
        password: value.password,
        role: value.role,
      };
      if (value.displayName.trim()) body.displayName = value.displayName.trim();
      const parsed = createUserRequestSchema.safeParse(body);
      if (!parsed.success) {
        setFormError(parsed.error.issues.map((i) => i.message).join('. '));
        return;
      }
      const outcome = await create(parsed.data);
      if (outcome.ok) await onSaved();
      else setFormError(outcome.error.message);
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Add user" description="Invite a person to this workspace.">
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
            <Alert tone="danger" title="Couldn't add the user">
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
          <form.Field name="displayName">
            {(field) => (
              <TextField
                label="Display name (optional)"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="password">
            {(field) => (
              <TextField
                label="Temporary password"
                type="password"
                autoComplete="new-password"
                description="At least 8 characters."
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
                options={roleOptions}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value as 'tenant_admin' | 'member')}
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
                  {isSubmitting ? 'Adding…' : 'Add user'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  update,
  onClose,
  onSaved,
}: {
  user: UserResponse;
  update: UsersSectionProps['update'];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      displayName: user.displayName ?? '',
      role: user.role,
      status: user.status,
      password: '',
    },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const body: Record<string, unknown> = {};
      const displayName = value.displayName.trim();
      if (displayName && displayName !== (user.displayName ?? '')) body.displayName = displayName;
      if (value.role !== user.role) body.role = value.role;
      if (value.status !== user.status) body.status = value.status;
      if (value.password) body.password = value.password;
      if (Object.keys(body).length === 0) {
        setFormError('Nothing to update.');
        return;
      }
      const parsed = updateUserRequestSchema.safeParse(body);
      if (!parsed.success) {
        setFormError(parsed.error.issues.map((i) => i.message).join('. '));
        return;
      }
      const outcome = await update(user.id, parsed.data);
      if (outcome.ok) await onSaved();
      else setFormError(outcome.error.message);
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Edit user" description={user.email}>
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
            <Alert tone="danger" title="Couldn't update the user">
              {formError}
            </Alert>
          ) : null}
          <form.Field name="displayName">
            {(field) => (
              <TextField
                label="Display name"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <div className="grid grid-cols-2 gap-3">
            <form.Field name="role">
              {(field) => (
                <SelectField
                  label="Role"
                  options={roleOptions}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as 'tenant_admin' | 'member')}
                />
              )}
            </form.Field>
            <form.Field name="status">
              {(field) => (
                <SelectField
                  label="Status"
                  options={statusOptions}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as 'active' | 'suspended')}
                />
              )}
            </form.Field>
          </div>
          <form.Field name="password">
            {(field) => (
              <TextField
                label="Reset password (optional)"
                type="password"
                autoComplete="new-password"
                description="Leave blank to keep the current password."
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
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
                  {isSubmitting ? 'Saving…' : 'Save changes'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
