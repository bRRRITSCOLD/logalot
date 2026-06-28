import type { AlertState } from '@logalot/contracts';
import { Badge } from '../../components/ui';

// Maps the evaluator-managed alert state to a token-driven badge. A disabled rule
// is never evaluated, so it reads as "paused" regardless of its last state.
export interface AlertStateBadgeProps {
  state: AlertState;
  enabled: boolean;
}

const LABELS: Record<AlertState, string> = {
  firing: 'Firing',
  ok: 'OK',
  no_data: 'No data',
};

export function AlertStateBadge({ state, enabled }: AlertStateBadgeProps) {
  if (!enabled) {
    return (
      <Badge tone="neutral" aria-label="Rule paused">
        Paused
      </Badge>
    );
  }
  const tone = state === 'firing' ? 'danger' : state === 'ok' ? 'success' : 'warning';
  return (
    <Badge tone={tone} aria-label={`Alert state: ${LABELS[state]}`}>
      {LABELS[state]}
    </Badge>
  );
}
