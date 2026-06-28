import { describe, expect, it } from 'vitest';
import { isNearBottom, NEAR_BOTTOM_PX, nextAutoscroll } from './scroll';

describe('isNearBottom', () => {
  it('is true exactly at the bottom', () => {
    // scrollHeight - scrollTop - clientHeight === 0 → within threshold.
    expect(isNearBottom(900, 1000, 100)).toBe(true);
  });

  it('is true within the threshold slack', () => {
    expect(isNearBottom(900 - (NEAR_BOTTOM_PX - 1), 1000, 100)).toBe(true);
  });

  it('is false once scrolled up beyond the threshold', () => {
    expect(isNearBottom(900 - (NEAR_BOTTOM_PX + 10), 1000, 100)).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(isNearBottom(800, 1000, 100, 5)).toBe(false); // gap of 100 > 5
    expect(isNearBottom(800, 1000, 100, 150)).toBe(true); // gap of 100 < 150
  });
});

describe('nextAutoscroll', () => {
  it('detaches when the user scrolls up while pinned', () => {
    expect(nextAutoscroll(true, false)).toBe(false);
  });

  it('re-arms when the user scrolls back to the bottom while detached (M1)', () => {
    expect(nextAutoscroll(false, true)).toBe(true);
  });

  it('stays pinned while at the bottom', () => {
    expect(nextAutoscroll(true, true)).toBe(true);
  });

  it('stays detached while still scrolled up', () => {
    expect(nextAutoscroll(false, false)).toBe(false);
  });
});
