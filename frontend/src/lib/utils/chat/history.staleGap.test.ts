import { describe, expect, it } from 'vitest';
import { nextHistoryRetryDecision, shouldFlagStaleEpochGap } from './history';

describe('shouldFlagStaleEpochGap', () => {
  it('flags a locally-held group that stayed behind after an epoch gap (the stale-device bug)', () => {
    // Group in WASM, replay hit an epoch gap, epoch did not advance -> forked behind.
    expect(shouldFlagStaleEpochGap(true, true, 3, 3)).toBe(true);
  });

  it('does not flag a group that caught up during replay (a commit advanced the epoch)', () => {
    expect(shouldFlagStaleEpochGap(true, true, 3, 5)).toBe(false);
  });

  it('does not flag when no epoch gap was seen', () => {
    expect(shouldFlagStaleEpochGap(true, false, 3, 3)).toBe(false);
  });

  it('does not flag a group absent from local WASM (handled by the missing-group path)', () => {
    expect(shouldFlagStaleEpochGap(false, true, -1, -1)).toBe(false);
  });
});

describe('nextHistoryRetryDecision', () => {
  it('keeps a fresh recoverable frame retryable (un-seen) so a later catch-up can decrypt it', () => {
    expect(nextHistoryRetryDecision(0)).toEqual({ attempts: 1, retry: true });
  });

  it('stays retryable across the first several failed replays', () => {
    // Attempts 1..5 remain retryable with a cap of 6.
    for (let prior = 0; prior < 5; prior++) {
      expect(nextHistoryRetryDecision(prior).retry).toBe(true);
    }
  });

  it('gives up once the retry cap is reached, so a permanently-undecryptable frame stops storming', () => {
    // The 6th attempt (prior=5) exhausts the bounded retries -> mark seen, advance cursor.
    expect(nextHistoryRetryDecision(5)).toEqual({ attempts: 6, retry: false });
    expect(nextHistoryRetryDecision(6).retry).toBe(false);
  });
});
