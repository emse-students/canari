/**
 * THE ONE DECISION FROM A FAILURE TO A SCREEN. `full` and the two retries are never confused, a
 * `not-found` means the end only once the viewer has played, and a transport failure is a retry.
 */
import { describe, it, expect } from 'vitest';
import { LiveRefusalError } from './api';
import { isTerminalLiveState, liveFailureOutcome, liveRetryDelayMs } from './liveViewerState';
import { TransportFailureError } from '$lib/utils/transportFailure';
import type { LiveRefusalKind } from './types';

const refusal = (kind: LiveRefusalKind, viewerCap: number | null = null) =>
  new LiveRefusalError(503, null, kind, kind, viewerCap, null, null);

const cutRefusal = () =>
  new LiveRefusalError(410, 'LIVE_ENDED', 'ended', 'ended', null, null, null, 'cut');

describe('liveFailureOutcome', () => {
  it.each([['seats-unavailable'], ['rate-limited'], ['unavailable'], ['retry-segment']] as const)(
    '%s is a retry, never "complet"',
    (kind) => {
      expect(liveFailureOutcome(refusal(kind), true)).toBe('retry');
      expect(liveFailureOutcome(refusal(kind), false)).toBe('retry');
    }
  );

  it('full is the "live complet" screen with the cap', () => {
    expect(liveFailureOutcome(refusal('full', 24), false)).toEqual({
      stop: { kind: 'full', viewerCap: 24 },
    });
  });

  it('ended is the end', () => {
    expect(liveFailureOutcome(refusal('ended'), false)).toEqual({
      stop: { kind: 'ended', cut: false },
    });
  });

  it('a 410 whose endReason is cut is the cut screen, joined or not', () => {
    expect(liveFailureOutcome(cutRefusal(), false)).toEqual({ stop: { kind: 'ended', cut: true } });
    expect(liveFailureOutcome(cutRefusal(), true)).toEqual({ stop: { kind: 'ended', cut: true } });
  });

  it('an ended refusal with another endReason, or none, is the plain end', () => {
    const dropped = new LiveRefusalError(
      410,
      'LIVE_ENDED',
      '',
      'ended',
      null,
      null,
      null,
      'dropped'
    );
    expect(liveFailureOutcome(dropped, true)).toEqual({ stop: { kind: 'ended', cut: false } });
  });

  it('not-found is unavailable before the join and the end after it', () => {
    expect(liveFailureOutcome(refusal('not-found'), false)).toEqual({
      stop: { kind: 'unavailable', reason: 'not-found' },
    });
    expect(liveFailureOutcome(refusal('not-found'), true)).toEqual({
      stop: { kind: 'ended', cut: false },
    });
  });

  it.each([
    ['removed', 'removed'],
    ['disabled', 'disabled'],
    ['refused', 'refused'],
    ['out-of-order', 'refused'],
  ] as const)('%s is the neutral unavailable screen', (kind, reason) => {
    expect(liveFailureOutcome(refusal(kind), true)).toEqual({
      stop: { kind: 'unavailable', reason },
    });
  });

  it('a transport failure is a retry; a defect of ours is not retried in a loop', () => {
    expect(liveFailureOutcome(new TransportFailureError('x'), true)).toBe('retry');
    expect(liveFailureOutcome(new Error('parser'), true)).toEqual({
      stop: { kind: 'unavailable', reason: 'refused' },
    });
  });
});

describe('liveRetryDelayMs', () => {
  it('doubles from 1 s and caps at 8 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(liveRetryDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe('isTerminalLiveState', () => {
  it('only full, ended and unavailable are final', () => {
    expect(isTerminalLiveState({ kind: 'full', viewerCap: null })).toBe(true);
    expect(isTerminalLiveState({ kind: 'ended', cut: false })).toBe(true);
    expect(isTerminalLiveState({ kind: 'unavailable', reason: 'removed' })).toBe(true);
    expect(isTerminalLiveState({ kind: 'playing' })).toBe(false);
    expect(isTerminalLiveState({ kind: 'reconnecting', reason: 'network' })).toBe(false);
    expect(isTerminalLiveState({ kind: 'connecting' })).toBe(false);
  });
});
