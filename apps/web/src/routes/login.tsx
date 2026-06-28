import { loginRequestSchema } from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import * as React from 'react';
import { Alert } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { TextField } from '../components/ui/text-field';
import { getSession, loginFn } from '../server/auth';

export const Route = createFileRoute('/login')({
  // Already-authenticated users skip the login screen.
  beforeLoad: async () => {
    const session = await getSession();
    if (session) throw redirect({ to: '/app' });
  },
  component: LoginPage,
});

// Collapse a field's standard-schema issues into a single display string.
function fieldError(errors: ReadonlyArray<unknown>): string | undefined {
  const messages = errors
    .map((e) => (typeof e === 'string' ? e : (e as { message?: string } | null)?.message))
    .filter((m): m is string => Boolean(m));
  return messages.length ? messages.join(', ') : undefined;
}

function LoginPage() {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm({
    defaultValues: { tenantSlug: '', email: '', password: '' },
    // Validate the whole payload with the SAME contract the control-plane uses.
    validators: { onSubmit: loginRequestSchema },
    onSubmit: async ({ value }) => {
      setFormError(null);
      const result = await loginFn({ data: value });
      if (result.ok) {
        // Re-run the authed guard's session check, then enter the app.
        await router.invalidate();
        await router.navigate({ to: '/app' });
      } else {
        setFormError(result.message);
      }
    },
  });

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Logalot</CardTitle>
          <CardDescription>Use your tenant workspace credentials.</CardDescription>
        </CardHeader>
        <CardContent>
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
              <Alert tone="danger" title="Sign-in failed">
                {formError}
              </Alert>
            ) : null}

            <form.Field name="tenantSlug">
              {(field) => (
                <TextField
                  label="Workspace"
                  placeholder="acme"
                  autoComplete="organization"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  error={
                    field.state.meta.isTouched ? fieldError(field.state.meta.errors) : undefined
                  }
                />
              )}
            </form.Field>

            <form.Field name="email">
              {(field) => (
                <TextField
                  label="Email"
                  type="email"
                  autoComplete="email"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  error={
                    field.state.meta.isTouched ? fieldError(field.state.meta.errors) : undefined
                  }
                />
              )}
            </form.Field>

            <form.Field name="password">
              {(field) => (
                <TextField
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  error={
                    field.state.meta.isTouched ? fieldError(field.state.meta.errors) : undefined
                  }
                />
              )}
            </form.Field>

            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting} className="w-full">
                  {isSubmitting ? 'Signing in…' : 'Sign in'}
                </Button>
              )}
            </form.Subscribe>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
