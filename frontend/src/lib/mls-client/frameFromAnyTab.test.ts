import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Whether this tab leads, as the send path reads it. */
const tab = vi.hoisted(() => ({ leads: true }));
vi.mock('./stateAuthority', () => ({
  refusesCommitsHere: () => !tab.leads,
  promotedSinceLoad: () => false,
}));
const delegateCommitToLeader = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/tabCommitDelegation', () => ({ delegateCommitToLeader }));
vi.mock('$lib/utils/graine/runtime', () => ({
  requireGraineRuntime: () => ({ deviceKey: () => new Uint8Array(32) }),
}));
vi.mock('$lib/encryption', () => ({
  sealBytes: async () => ({ iv: new Uint8Array([1]), cipherText: new Uint8Array([2]) }),
  openSealedBytes: async () => null,
}));

import { FrameNotHandedError, sendFrameFromThisTab } from './frameFromAnyTab';
import { FollowerTabSendError } from './commitSubmission';

const GROUP = 'group-0123456789';
const BYTES = new Uint8Array([7, 7, 7]);

describe('sendFrameFromThisTab when the lead leaves during the send (review of #2515)', () => {
  beforeEach(() => {
    tab.leads = true;
    delegateCommitToLeader.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  /** A send that the service refuses after its count because the lead left inside it. */
  const leadLostService = () => ({
    sendMessage: vi.fn(async () => {
      tab.leads = false;
      throw new FollowerTabSendError(GROUP, 'lead-lost');
    }),
  });

  it('hands the gesture to the leader tab, which sends it and answers its time', async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: { receivedAt: 42 } });
    const svc = leadLostService();
    await expect(sendFrameFromThisTab(svc, GROUP, BYTES)).resolves.toEqual({ receivedAt: 42 });
    expect(svc.sendMessage).toHaveBeenCalledTimes(1);
    expect(delegateCommitToLeader).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'emit-frame', groupId: GROUP, delivery: 'visible' })
    );
  });

  it("fails as the caller's typed failure when the leader does not send it - never lost", async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'refused', reason: 'leader-gone' });
    const refused = await sendFrameFromThisTab(leadLostService(), GROUP, BYTES).catch(
      (e: unknown) => e
    );
    expect(refused).toBeInstanceOf(FrameNotHandedError);
  });

  it('rethrows every other failure of the send unchanged, and hands nothing over', async () => {
    const boom = new Error('network');
    const svc = { sendMessage: vi.fn(async () => Promise.reject(boom)) };
    await expect(sendFrameFromThisTab(svc, GROUP, BYTES)).rejects.toBe(boom);
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
  });
});
