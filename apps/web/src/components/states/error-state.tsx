import { Link, useRouter } from '@tanstack/react-router';
import type * as React from 'react';
import { cn } from '../../lib/cn';
import { Button, buttonVariants } from '../ui/button';

export interface ErrorStateProps {
  title?: string;
  message?: string;
  /** Optional retry handler; renders a "Try again" button when provided. */
  onRetry?: () => void;
  action?: React.ReactNode;
  className?: string;
}

// Presentational error block. role="alert" so screen readers announce it.
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-card border border-severity-error-border bg-severity-error-bg p-12 text-center',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-fg-default">{title}</p>
        {message ? <p className="text-fg-muted text-sm">{message}</p> : null}
      </div>
      <div className="flex gap-2 pt-1">
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {action}
      </div>
    </div>
  );
}

// Router-level catch boundary (wired in router.tsx). Offers a reload that
// re-runs loaders via router.invalidate(), plus an escape hatch home.
export function DefaultCatchBoundary({ error }: { error: Error }) {
  const router = useRouter();
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <ErrorState
        title="Unexpected error"
        message={error.message}
        onRetry={() => router.invalidate()}
        action={
          <Link to="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Go home
          </Link>
        }
      />
    </div>
  );
}

// Router-level 404 (wired in router.tsx).
export function NotFound() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <ErrorState
        title="Page not found"
        message="The page you’re looking for doesn’t exist or has moved."
        action={
          <Link to="/" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            Go home
          </Link>
        }
      />
    </div>
  );
}
