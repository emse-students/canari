/**
 * `pollDeadlineClock` moves when a deadline ARRIVES - measured from now, never from the instant it
 * last moved.
 *
 * A clock that lives long (the salon's "N active polls" shortcut sits in `ChatArea`, which is never
 * remounted across conversations) is handed polls hours after its `at` was last set. Measuring the
 * next deadline from that stale `at` scheduled it hours late, so a poll whose end date had passed
 * stayed in the shortcut. Every instant here is a constant on fake timers: no wall clock is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { pollDeadlineClock } from './pollDeadline.svelte';
import { pollDeadlinePassed, type PollDeadline } from './pollVote';

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pollDeadlineClock', () => {
  it('a poll handed in hours after the clock was made closes at its own deadline', () => {
    let polls = $state<PollDeadline[]>([]);
    const cleanup = $effect.root(() => {
      const clock = pollDeadlineClock(() => polls);
      flushSync();
      // Four hours pass with nothing to schedule, then a poll ending five minutes later arrives.
      vi.setSystemTime(T0 + 4 * HOUR);
      const deadline = T0 + 4 * HOUR + 5 * 60_000;
      polls = [{ endsAt: iso(deadline) }];
      flushSync();
      expect(pollDeadlinePassed(polls[0].endsAt, clock.at)).toBe(false);
      vi.advanceTimersByTime(5 * 60_000);
      flushSync();
      expect(pollDeadlinePassed(polls[0].endsAt, clock.at)).toBe(true);
    });
    cleanup();
  });

  it('a poll handed in after its deadline already passed is judged over at once', () => {
    let polls = $state<PollDeadline[]>([]);
    const cleanup = $effect.root(() => {
      const clock = pollDeadlineClock(() => polls);
      flushSync();
      vi.setSystemTime(T0 + 2 * HOUR);
      polls = [{ endsAt: iso(T0 + HOUR) }];
      flushSync();
      expect(pollDeadlinePassed(polls[0].endsAt, clock.at)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
    cleanup();
  });

  it('leaves no timer behind once torn down', () => {
    const cleanup = $effect.root(() => {
      pollDeadlineClock(() => [{ endsAt: iso(T0 + HOUR) }]);
      flushSync();
      expect(vi.getTimerCount()).toBe(1);
    });
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
