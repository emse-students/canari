import { describe, it, expect, vi } from 'vitest';
import { attemptCommitReplay } from './commitReplay';

function makeMls(overrides: Record<string, unknown>) {
  return {
    getEpoch: vi.fn().mockReturnValue(0),
    fetchCommitsSince: vi.fn(),
    processIncomingMessage: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

const noop = () => {};

describe('attemptCommitReplay', () => {
  it('heals the gap by applying the missed commits in order', async () => {
    let epoch = 2;
    const mls = makeMls({
      getEpoch: vi.fn(() => epoch),
      fetchCommitsSince: vi.fn().mockResolvedValue({
        commits: [
          { baseEpoch: 2, proto: 'AA==' },
          { baseEpoch: 3, proto: 'AA==' },
        ],
        activeEpoch: 4,
        belowFloor: false,
      }),
      processIncomingMessage: vi.fn(async () => {
        epoch++;
        return null;
      }),
    });

    const res = await attemptCommitReplay(mls, 'g', noop);

    expect(res.healed).toBe(true);
    expect(res.applied).toBe(2);
    expect(mls.processIncomingMessage).toHaveBeenCalledTimes(2);
  });

  it('returns belowFloor without applying anything when the commits were pruned', async () => {
    const mls = makeMls({
      getEpoch: vi.fn().mockReturnValue(2),
      fetchCommitsSince: vi
        .fn()
        .mockResolvedValue({ commits: [], activeEpoch: 9, belowFloor: true }),
    });

    const res = await attemptCommitReplay(mls, 'g', noop);

    expect(res.belowFloor).toBe(true);
    expect(res.healed).toBe(false);
    expect(mls.processIncomingMessage).not.toHaveBeenCalled();
  });

  it('stops at the first commit that fails to apply and reports not healed', async () => {
    let epoch = 2;
    const mls = makeMls({
      getEpoch: vi.fn(() => epoch),
      fetchCommitsSince: vi.fn().mockResolvedValue({
        commits: [
          { baseEpoch: 2, proto: 'AA==' },
          { baseEpoch: 3, proto: 'AA==' },
        ],
        activeEpoch: 4,
        belowFloor: false,
      }),
      processIncomingMessage: vi
        .fn()
        .mockImplementationOnce(async () => {
          epoch++;
          return null;
        })
        .mockRejectedValueOnce(new Error('cannot re-process own commit')),
    });

    const res = await attemptCommitReplay(mls, 'g', noop);

    expect(res.applied).toBe(1);
    expect(res.healed).toBe(false); // reached epoch 3, target was 4
  });
});
