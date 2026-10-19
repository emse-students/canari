/** The wheel's step and its one-gesture-one-page lock (`reelWheel.ts`). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WHEEL_QUIET_MS, WheelPageLock, wheelStep } from './reelWheel';

describe('wheelStep', () => {
  it('down is the next reel, up the previous', () => {
    expect(wheelStep({ deltaX: 0, deltaY: 3, ctrlKey: false })).toBe('next');
    expect(wheelStep({ deltaX: 0, deltaY: -3, ctrlKey: false })).toBe('prev');
  });
  it('a zoom, a horizontal scroll and a zero delta ask for nothing', () => {
    expect(wheelStep({ deltaX: 0, deltaY: 3, ctrlKey: true })).toBeNull();
    expect(wheelStep({ deltaX: 9, deltaY: 3, ctrlKey: false })).toBeNull();
    expect(wheelStep({ deltaX: 0, deltaY: 0, ctrlKey: false })).toBeNull();
  });
});

describe('WheelPageLock', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('is free again only once the wheel has been quiet, and every event restarts the quiet', () => {
    const lock = new WheelPageLock();
    expect(lock.free).toBe(true);
    lock.heard();
    expect(lock.free).toBe(false);
    vi.advanceTimersByTime(WHEEL_QUIET_MS - 1);
    lock.heard();
    vi.advanceTimersByTime(WHEEL_QUIET_MS - 1);
    expect(lock.free).toBe(false);
    vi.advanceTimersByTime(2);
    expect(lock.free).toBe(true);
    lock.dispose();
  });
});
