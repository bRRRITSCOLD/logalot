import { type LogLevel, logLevelSchema } from '@logalot/contracts';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';

// One badge parameterized by the six log severities (issue #19's first-class
// severity palette). Each level reads its fg/bg/border from the severity tokens,
// so there is zero per-level CSS here — adding a level is a token change.
export const logLevelBadgeVariants = cva(
  'inline-flex items-center rounded-pill border px-1.5 font-mono text-2xs uppercase tracking-wide',
  {
    variants: {
      level: {
        trace: 'text-severity-trace-fg bg-severity-trace-bg border-severity-trace-border',
        debug: 'text-severity-debug-fg bg-severity-debug-bg border-severity-debug-border',
        info: 'text-severity-info-fg bg-severity-info-bg border-severity-info-border',
        warn: 'text-severity-warn-fg bg-severity-warn-bg border-severity-warn-border',
        error: 'text-severity-error-fg bg-severity-error-bg border-severity-error-border',
        fatal: 'text-severity-fatal-fg bg-severity-fatal-bg border-severity-fatal-border',
      } satisfies Record<LogLevel, string>,
    },
    defaultVariants: { level: 'info' },
  },
);

export interface LogLevelBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof logLevelBadgeVariants> {
  level: LogLevel;
}

export function LogLevelBadge({ className, level, ...props }: LogLevelBadgeProps) {
  // Validate at the boundary: an unknown level (e.g. from an API drift) must not
  // silently render an unstyled badge — fail loud in dev via the shared contract.
  const safe = logLevelSchema.parse(level);
  return (
    <span className={cn(logLevelBadgeVariants({ level: safe }), className)} {...props}>
      {safe}
    </span>
  );
}
