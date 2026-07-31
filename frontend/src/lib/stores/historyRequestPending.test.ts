import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { historyRequestPendingStore, RETRY_DELAYS_MS } from './historyRequestPending.svelte';

const REQUEST_TIMEOUT_MS = 30_000;

describe('historyRequestPendingStore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    historyRequestPendingStore.cancelAll();
  });

  afterEach(() => {
    historyRequestPendingStore.cancelAll();
    vi.useRealTimers();
  });

  it('starts in pending and moves to pending-offline after the timeout', () => {
    const retry = vi.fn();
    historyRequestPendingStore.start('g1', retry);

    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');
    expect(retry).not.toHaveBeenCalled();
  });

  it('clears the state when the bundle is received before the timeout', () => {
    const retry = vi.fn();
    historyRequestPendingStore.start('g1', retry);

    vi.advanceTimersByTime(10_000);
    historyRequestPendingStore.noteReceived('g1');

    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('schedules up to 3 retries with the documented backoff', () => {
    const retry = vi.fn();
    const startRetry = () => {
      retry();
      historyRequestPendingStore.start('g1', startRetry);
    };
    historyRequestPendingStore.start('g1', startRetry);

    // Request window elapses -> first retry scheduled (30 s backoff).
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');

    vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    // New request window elapses -> second retry scheduled (2 min backoff).
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');

    vi.advanceTimersByTime(RETRY_DELAYS_MS[1]);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    // New request window elapses -> third retry scheduled (5 min backoff).
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');

    vi.advanceTimersByTime(RETRY_DELAYS_MS[2]);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    // Budget exhausted: the request window can elapse but no further retry is scheduled.
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');
    vi.advanceTimersByTime(600_000);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it('moves straight to pending-offline on markOffline and schedules only one retry', () => {
    const retry = vi.fn();
    historyRequestPendingStore.start('g1', retry);

    historyRequestPendingStore.markOffline('g1');
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');

    // The original 30 s request timer was cancelled; the retry timer has not fired yet.
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    expect(retry).not.toHaveBeenCalled();

    // Retry fires on the documented backoff.
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);

    // No duplicate retry is scheduled by the cancelled request timeout.
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('restarts cleanly without resetting the retry budget when start is called again', () => {
    const firstRetry = vi.fn();
    const secondRetry = vi.fn();
    historyRequestPendingStore.start('g1', firstRetry);

    // Consume the first retry.
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + RETRY_DELAYS_MS[0]);
    expect(firstRetry).toHaveBeenCalledTimes(1);

    // A fresh solicitation for the same group preserves the budget.
    historyRequestPendingStore.start('g1', secondRetry);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');

    // The next scheduled retry uses the second backoff slot, not the first one again.
    vi.advanceTimersByTime(RETRY_DELAYS_MS[1]);
    expect(secondRetry).toHaveBeenCalledTimes(1);
  });

  it('onResume retries pending-offline groups that still have budget', () => {
    const retry = vi.fn();
    const startRetry = () => {
      retry();
      historyRequestPendingStore.start('g1', startRetry);
    };
    historyRequestPendingStore.start('g1', startRetry);
    historyRequestPendingStore.markOffline('g1');

    vi.advanceTimersByTime(10_000);
    historyRequestPendingStore.onResume();

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('onResume does not retry groups that have exhausted their budget', () => {
    const retry = vi.fn();
    const startRetry = () => {
      retry();
      historyRequestPendingStore.start('g1', startRetry);
    };
    historyRequestPendingStore.start('g1', startRetry);

    // Run through all 3 retries (each retry restarts the 30 s request window).
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + RETRY_DELAYS_MS[0]);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + RETRY_DELAYS_MS[1]);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + RETRY_DELAYS_MS[2]);
    expect(retry).toHaveBeenCalledTimes(3);
    retry.mockClear();

    historyRequestPendingStore.onResume();
    expect(retry).not.toHaveBeenCalled();
  });

  it('cancelAll removes every tracked group', () => {
    historyRequestPendingStore.start('g1', vi.fn());
    historyRequestPendingStore.start('g2', vi.fn());

    historyRequestPendingStore.cancelAll();

    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
    expect(historyRequestPendingStore.getPhase('g2')).toBeNull();
  });
});
