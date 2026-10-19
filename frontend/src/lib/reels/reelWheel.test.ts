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

  it('holds until the page has landed AND the wheel went quiet', () => {
    const lock = new WheelPageLock();
    expect(lock.free).toBe(true);
    lock.heard();
    lock.take();
    vi.advanceTimersByTime(WHEEL_QUIET_MS + 1);
    // Quiet, but the transition is still running.
    expect(lock.free).toBe(false);
    lock.land();
    expect(lock.free).toBe(true);
  });

  it('an inertia tail after the landing restarts the quiet, so it never turns a second page', () => {
    const lock = new WheelPageLock();
    lock.heard();
    lock.take();
    lock.land();
    vi.advanceTimersByTime(WHEEL_QUIET_MS - 1);
    lock.heard();
    vi.advanceTimersByTime(WHEEL_QUIET_MS - 1);
    expect(lock.free).toBe(false);
    vi.advanceTimersByTime(2);
    expect(lock.free).toBe(true);
    lock.dispose();
  });
});
