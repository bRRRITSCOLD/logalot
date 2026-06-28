import type * as React from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional call-to-action (e.g. a Button or Link). */
  action?: React.ReactNode;
  /** Optional decorative icon. */
  icon?: React.ReactNode;
  className?: string;
}

// The "nothing here yet" state — distinct from loading (no spinner) and error
// (no alarm). Feature pages (#21-#23) reuse this for empty result sets.
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-card border border-border-subtle border-dashed p-12 text-center',
        className,
      )}
    >
      {icon ? <div className="text-fg-subtle">{icon}</div> : null}
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-fg-default">{title}</p>
        {description ? <p className="text-fg-muted text-sm">{description}</p> : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
