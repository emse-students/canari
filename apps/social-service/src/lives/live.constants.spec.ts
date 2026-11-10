import {
  LIVE_REPLAY_TOTAL_MAX_GB_DEFAULT,
  liveLimits,
  liveReplayTotalMaxBytes,
} from './live.constants';

describe('liveLimits - no duration cap, no total byte budget (owner, 2026-10-31)', () => {
  it('serves neither a longest duration nor a byte budget', () => {
    const limits = liveLimits() as Record<string, unknown>;
    expect(limits).not.toHaveProperty('maxDurationMs');
    expect(limits).not.toHaveProperty('byteBudget');
  });

  it('keeps the guards that bound a live without a clock', () => {
    expect(liveLimits()).toMatchObject({
      segmentMaxBytes: 4 * 1024 * 1024,
      segmentBurst: 15,
      segmentMinDurationMs: 1_000,
    });
  });
});

describe('liveReplayTotalMaxBytes - the replays total cap (owner, 2026-11-09, D5)', () => {
  it('is 20 GB when unset or empty', () => {
    expect(LIVE_REPLAY_TOTAL_MAX_GB_DEFAULT).toBe(20);
    expect(liveReplayTotalMaxBytes(undefined)).toBe(20e9);
    expect(liveReplayTotalMaxBytes('  ')).toBe(20e9);
  });

  it('reads a positive number of GB, a fraction allowed', () => {
    expect(liveReplayTotalMaxBytes('50')).toBe(50e9);
    expect(liveReplayTotalMaxBytes('0.5')).toBe(5e8);
  });

  it('THROWS on a value that is set and not a positive number: a typo never means no cap', () => {
    for (const bad of ['0', '-1', 'twenty', '20GB', 'NaN', 'Infinity']) {
      expect(() => liveReplayTotalMaxBytes(bad)).toThrow(/LIVE_REPLAY_TOTAL_MAX_GB/);
    }
  });
});
