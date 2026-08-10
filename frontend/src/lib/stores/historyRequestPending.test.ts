import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { historyRequestPendingStore } from './historyRequestPending.svelte';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The store tracks ONE attempt per group and drives none.
 *
 * It used to own a retry ladder (`RETRY_DELAYS_MS`, `MAX_RETRIES`) while `historySolicit` owned a
 * second, independent one - two schedules multiplying into traffic no single file could predict.
 * Asking now belongs entirely to `solicitHistory`, so the property to pin here is a negative one:
 * nothing this store does ever produces a request.
 */
describe('historyRequestPendingStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    historyRequestPendingStore.cancelAll();
  });

  afterEach(() => {
    historyRequestPendingStore.cancelAll();
    vi.useRealTimers();
  });

  it('opens a window on start and closes it when the answer never comes', () => {
    historyRequestPendingStore.start('g1');
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unanswered');
  });

  it('stops tracking once the bundle arrives', () => {
    historyRequestPendingStore.start('g1');
    historyRequestPendingStore.noteReceived('g1');
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();

    // The window must be dead, not merely unread: a stale timer would re-open a phase for a group
    // whose attempt has settled, and the UI would claim a request is outstanding forever.
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 10);
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
  });

  it('reports a request that never left the device as over immediately, and says WHY', () => {
    historyRequestPendingStore.start('g1');
    historyRequestPendingStore.markUnsent('g1');
    // Not merely "over": `unsent` and `unanswered` are what the UI tells the user, and telling
    // somebody nobody was online when a peer was online and silent is a wrong answer, not a vague one.
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unsent');
  });

  it('NEVER schedules anything: a timed-out attempt stays over', () => {
    // The regression this exists for. Both ladders re-fired from inside a timer, so one detection
    // could still be generating traffic minutes later with no further evidence of a problem.
    historyRequestPendingStore.start('g1');
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    vi.advanceTimersByTime(60 * 60_000);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unanswered');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a finished attempt on resume, and asks for nothing', () => {
    // Resuming means the UI should stop claiming an attempt is outstanding. Re-soliciting is
    // `reSolicitAwaitingHistory`'s single job, reached through the reconnect this resume triggers.
    historyRequestPendingStore.start('g1');
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    historyRequestPendingStore.onResume();
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a still-open window alone on resume', () => {
    historyRequestPendingStore.start('g1');
    historyRequestPendingStore.onResume();
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');
  });

  it('tracks groups independently', () => {
    historyRequestPendingStore.start('g1');
    historyRequestPendingStore.start('g2');
    historyRequestPendingStore.noteReceived('g1');

    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
    expect(historyRequestPendingStore.getPhase('g2')).toBe('pending');
  });

  it('cancels everything on teardown', () => {
    historyRequestPendingStore.start('g1');
    historyRequestPendingStore.start('g2');
    historyRequestPendingStore.cancelAll();

    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
    expect(historyRequestPendingStore.getPhase('g2')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
