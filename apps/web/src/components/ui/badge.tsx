import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-pill border px-1.5 py-0.5 font-medium text-xs',
  {
    variants: {
      tone: {
        neutral: 'border-border-default bg-bg-elevated text-fg-muted',
        brand: 'border-transparent bg-brand-muted text-brand-fg',
        success: 'border-transparent bg-bg-elevated text-status-success',
        warning: 'border-transparent bg-bg-elevated text-status-warning',
        danger: 'border-transparent bg-bg-elevated text-status-danger',
        info: 'border-transparent bg-bg-elevated text-status-info',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
