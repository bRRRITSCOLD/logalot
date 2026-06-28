import { cn } from '../../lib/cn';
import { Spinner } from '../ui/spinner';

export interface LoadingStateProps {
  label?: string;
  className?: string;
}

// Centered busy indicator for route/data loading. The Spinner carries the
// accessible status role; the visible text is decorative/duplicative.
export function LoadingState({ label = 'Loading…', className }: LoadingStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 p-12 text-fg-muted',
        className,
      )}
    >
      <Spinner className="size-6" label={label} />
      <p className="text-sm">{label}</p>
    </div>
  );
}
