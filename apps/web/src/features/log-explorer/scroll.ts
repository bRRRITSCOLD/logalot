// Pure autoscroll decision logic, factored out of the LogExplorer component so it is
// unit-testable: jsdom has no layout (scrollTop/scrollHeight/clientHeight are all 0),
// so the scroll effect never meaningfully runs in tests — the decision must be proven
// in isolation, not through the DOM.

/** Px slack from the bottom still treated as "at the bottom" (sub-pixel/rounding). */
export const NEAR_BOTTOM_PX = 24;

/** Whether the scroll position is within `threshold` px of the bottom. */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = NEAR_BOTTOM_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

/**
 * Next autoscroll flag given the current flag and whether the view is at the bottom.
 *   • scrolled UP while pinned  → detach (stop yanking the user to the latest line)
 *   • scrolled back to BOTTOM while detached → re-arm (resume following the tail)
 *   • otherwise unchanged
 * The two-way behaviour is the M1 fold: re-attachment used to be missing.
 */
export function nextAutoscroll(current: boolean, atBottom: boolean): boolean {
  if (!atBottom && current) return false;
  if (atBottom && !current) return true;
  return current;
}
