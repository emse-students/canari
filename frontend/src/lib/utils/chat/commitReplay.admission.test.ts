// @vitest-environment happy-dom
/**
 * A COMMIT THAT BRINGS A NEW USER INTO A CLOSED GROUP IS NOT A REPLAY THAT FAILED.
 *
 * The replay is rung 1 of the epoch-gap ladder, and what its `break` hands back is rung 2: forget the
 * group and rebuild this device from the server's state. After a refused admission that state holds
 * the person, so the replay freezes the group instead (`admissionFreeze.ts`), and the caller reads
 * the freeze rather than escalating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const noteFrameConsumed = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/history', () => ({
  noteFrameConsumed: (u: string, g: string, b: Uint8Array) => noteFrameConsumed(u, g, b),
}));

import { attemptCommitReplay } from './commitReplay';
import {
  isFrozenByAdmissionRefusal,
  resetAdmissionFreezes,
  setAdmissionFreezeListener,
} from './admissionFreeze';

function makeMls(overrides: Record<string, unknown>) {
  return {
    getEpoch: vi.fn().mockReturnValue(4),
    fetchCommitsSince: vi.fn().mockResolvedValue({
      commits: [{ baseEpoch: 4, proto: 'AQ==' }],
      activeEpoch: 5,
      belowFloor: false,
    }),
    processIncomingMessage: vi.fn().mockResolvedValue(null),
    settleUnresolvedCommitFromLog: vi.fn().mockResolvedValue('none'),
    ...overrides,
  } as any;
}

beforeEach(() => {
  resetAdmissionFreezes();
  noteFrameConsumed.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('attemptCommitReplay - a refused admission', () => {
  it('freezes the group, tells the listener, and does not claim the commit as read', async () => {
    const listener = vi.fn();
    setAdmissionFreezeListener(listener);
    const mls = makeMls({
      processIncomingMessage: vi
        .fn()
        .mockRejectedValue(new Error('ADMISSION_REFUSED: mallory:dev1 entered by external commit')),
    });

    const result = await attemptCommitReplay(mls, 'g1', 'user-a', vi.fn());

    expect(isFrozenByAdmissionRefusal('g1')).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ entrant: 'mallory:dev1' }));
    expect(result.healed).toBe(false);
    // A refused commit consumed nothing, and claiming it would tell every later reader "already read".
    expect(noteFrameConsumed).not.toHaveBeenCalled();
  });

  it('control: any other refusal stops the replay without freezing the group', async () => {
    const mls = makeMls({
      processIncomingMessage: vi.fn().mockRejectedValue(new Error('Process error: epoch gap')),
    });

    const result = await attemptCommitReplay(mls, 'g1', 'user-a', vi.fn());

    expect(isFrozenByAdmissionRefusal('g1')).toBe(false);
    expect(result.healed).toBe(false);
  });
});
