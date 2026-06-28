import type * as React from 'react';
import { cn } from '../../lib/cn';

export interface SpinnerProps extends React.SVGProps<SVGSVGElement> {
  /** Accessible label; defaults to "Loading". Rendered as an aria-label on role=status. */
  label?: string;
}

// A token-styled indeterminate spinner. role="status" + aria-label announce the
// busy state to assistive tech without a hand-rolled live region.
export function Spinner({ className, label = 'Loading', ...props }: SpinnerProps) {
  return (
    <svg
      role="status"
      aria-label={label}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('size-4 animate-spin text-fg-muted', className)}
      {...props}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
