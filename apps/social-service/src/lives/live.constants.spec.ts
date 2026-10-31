import { LIVE_LEGACY_MAX_DURATION_MS, liveLimits } from './live.constants';

describe('liveLimits - no duration cap, no total byte budget (owner, 2026-10-31)', () => {
  it('serves no byte budget, and a maxDurationMs an installed client can print without a NaN', () => {
    const limits = liveLimits() as Record<string, unknown>;
    expect(limits).not.toHaveProperty('byteBudget');
    // Builds up to 1.5.x show floor(maxDurationMs / 60000) minutes: a number, never null or absent.
    expect(limits.maxDurationMs).toBe(LIVE_LEGACY_MAX_DURATION_MS);
    expect(Number.isSafeInteger(limits.maxDurationMs)).toBe(true);
  });

  it('keeps the guards that bound a live without a clock', () => {
    expect(liveLimits()).toMatchObject({
      segmentMaxBytes: 4 * 1024 * 1024,
      segmentBurst: 15,
      segmentMinDurationMs: 1_000,
    });
  });
});
