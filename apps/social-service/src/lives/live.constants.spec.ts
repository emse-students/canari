import { liveLimits } from './live.constants';

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
