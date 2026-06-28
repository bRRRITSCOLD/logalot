import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';

export const alertVariants = cva('flex gap-2.5 rounded-card border p-3 text-sm', {
  variants: {
    tone: {
      info: 'border-border-default bg-bg-elevated text-fg-default',
      success: 'border-severity-info-border bg-severity-info-bg text-fg-default',
      warning: 'border-severity-warn-border bg-severity-warn-bg text-fg-default',
      danger: 'border-severity-error-border bg-severity-error-bg text-fg-default',
    },
  },
  defaultVariants: { tone: 'info' },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  title?: string;
}

// Inline callout for form/page errors and notices. Danger/warning alerts announce
// assertively (role="alert"); informational ones use role="status".
export function Alert({ className, tone = 'info', title, children, ...props }: AlertProps) {
  const assertive = tone === 'danger' || tone === 'warning';
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <div className="flex flex-col gap-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-fg-muted">{children}</div> : null}
      </div>
    </div>
  );
}
