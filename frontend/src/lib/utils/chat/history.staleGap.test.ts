import { describe, expect, it } from 'vitest';
import { shouldFlagStaleEpochGap } from './history';

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
