// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redrawEveryMinuteAndAt } from './redrawClock';

describe('redrawEveryMinuteAndAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-02T08:59:30Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('ticks every minute, and once at the opening instant', () => {
    const ticks: number[] = [];
    const stop = redrawEveryMinuteAndAt(Date.parse('2026-11-02T09:00:00Z'), (now) =>
      ticks.push(now)
    );
    vi.advanceTimersByTime(30_001);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toBeGreaterThanOrEqual(Date.parse('2026-11-02T09:00:00Z'));
    vi.advanceTimersByTime(60_000);
    expect(ticks).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(600_000);
    expect(ticks).toHaveLength(2);
  });

  it('schedules nothing extra for an opening already past, or none', () => {
    const ticks: number[] = [];
    const stop = redrawEveryMinuteAndAt(Date.parse('2026-11-01T00:00:00Z'), (now) =>
      ticks.push(now)
    );
    vi.advanceTimersByTime(59_999);
    expect(ticks).toEqual([]);
    stop();
  });

  it('redraws when the page comes back into view', () => {
    const ticks: number[] = [];
    const stop = redrawEveryMinuteAndAt(null, (now) => ticks.push(now));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ticks).toHaveLength(document.visibilityState === 'visible' ? 1 : 0);
    stop();
  });
});
