import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names with Tailwind-aware conflict resolution: later utilities win
 * over earlier ones in the same property group (e.g. `px-2 px-4` -> `px-4`). This
 * is the single class-composition helper every component uses so a caller's
 * `className` can always override a component default.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
