import { loginRequestSchema } from '@logalot/contracts';
import { useForm } from '@tanstack/react-form';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import * as React from 'react';
import { Alert } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { TextField } from '../components/ui/text-field';
import { getSession, loginFn } from '../server/auth';
import { startGoogleSignin } from '../server/oidc';

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
  const [googleError, setGoogleError] = React.useState<string | null>(null);
  const [googlePending, setGooglePending] = React.useState(false);
  // Workspace slug typed into the primary form field — shared with Google sign-in.
  const [tenantSlug, setTenantSlug] = React.useState('');

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

  async function handleGoogleSignin() {
    setGoogleError(null);
    const slug = tenantSlug.trim();
    if (!slug) {
      setGoogleError('Enter your workspace name to sign in with Google.');
      return;
    }
    setGooglePending(true);
    try {
      const result = await startGoogleSignin({ data: { tenantSlug: slug } });
      if (result.ok) {
        // Navigate the browser to the IdP authorization page.
        window.location.href = result.redirectUrl;
      } else {
        setGoogleError(result.message);
        setGooglePending(false);
      }
    } catch {
      setGoogleError('Something went wrong. Please try again.');
      setGooglePending(false);
    }
  }

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
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                    // Keep the shared tenantSlug state in sync so the Google
                    // sign-in button can use the same value.
                    setTenantSlug(e.target.value);
                  }}
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

          {/* ── Divider ───────────────────────────────────────────────── */}
          <div className="relative my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border-default" />
            <span className="text-xs text-fg-muted">or</span>
            <div className="h-px flex-1 bg-border-default" />
          </div>

          {/* ── Google sign-in ────────────────────────────────────────── */}
          {googleError ? (
            <Alert tone="danger" title="Sign-in with Google failed" className="mb-3">
              {googleError}
            </Alert>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={googlePending}
            onClick={() => void handleGoogleSignin()}
            className="w-full gap-2"
          >
            {/* Google "G" icon (inline SVG — no external image request). */}
            <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true" focusable="false">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {googlePending ? 'Redirecting…' : 'Sign in with Google'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
