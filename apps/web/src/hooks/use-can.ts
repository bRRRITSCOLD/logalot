import { can, type UiOperation } from '@logalot/contracts';
import { useSession } from './use-session';

/**
 * DISPLAY-ONLY permission predicate bound to the current session's role. Used to
 * hide/disable actions a role cannot perform. This is defense-in-depth UX, NEVER a
 * security control — the control-plane re-checks every operation server-side, and
 * privileged data is gated at the server-side fetch (see server/admin.ts). A forged
 * client role still gets a 403.
 */
export function useCan(): (operation: UiOperation) => boolean {
  const session = useSession();
  return (operation) => can(session.role, operation);
}
