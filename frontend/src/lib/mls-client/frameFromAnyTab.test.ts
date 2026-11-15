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
/** What the leader's open of a handed frame returns (`null`: the device key changed). */
const opened = vi.hoisted(() => ({ bytes: null as Uint8Array | null, lose: false }));
vi.mock('$lib/encryption', () => ({
  sealBytes: async () => ({ iv: new Uint8Array([1]), cipherText: new Uint8Array([2]) }),
  openSealedBytes: async () => {
    // The lead leaving during the leader's open of a handed frame.
    if (opened.lose) tab.leads = false;
    return opened.bytes;
  },
}));

import {
  FrameNotHandedError,
  frameHandoverExecutors,
  sendFrameFromThisTab,
} from './frameFromAnyTab';
import { FollowerTabSendError } from './commitSubmission';

const GROUP = 'group-0123456789';
const BYTES = new Uint8Array([7, 7, 7]);
/** The sealed half of a `SentFrame`, which these cases do not read. */
const FRAME_BYTES = { sealed: new Uint8Array([1]), authorProof: new Uint8Array([2]) };

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

describe("the leader half when the lead leaves it while it runs a follower's frame", () => {
  const OP = {
    kind: 'emit-frame' as const,
    groupId: GROUP,
    frame: { iv: 'AQ==', cipherText: 'Ag==' },
    delivery: 'visible' as const,
  };
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    tab.leads = true;
    opened.bytes = BYTES;
    opened.lose = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('answers unsent by value when the send refuses with lead-lost - nothing at error', async () => {
    const svc = {
      sendMessage: vi.fn(async () => {
        tab.leads = false;
        throw new FollowerTabSendError(GROUP, 'lead-lost');
      }),
    };
    await expect(frameHandoverExecutors(() => svc)['emit-frame'](OP)).resolves.toEqual({
      unsent: 'lead-lost',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('never delegates: a lead lost during the open reaches the send, which refuses it by type', async () => {
    delegateCommitToLeader.mockReset();
    opened.lose = true;
    // As `BaseMlsService.sendMessage` does at its entry for a document that led and lost the lead.
    const svc = {
      sendMessage: vi.fn(async () => {
        if (!tab.leads) throw new FollowerTabSendError(GROUP, 'lead-lost');
        return { receivedAt: 1, ...FRAME_BYTES };
      }),
    };
    await expect(frameHandoverExecutors(() => svc)['emit-frame'](OP)).resolves.toEqual({
      unsent: 'lead-lost',
    });
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a lead lost during the post is a frame on the wire: answered sent', async () => {
    const svc = {
      sendMessage: vi.fn(async () => {
        tab.leads = false;
        return { receivedAt: 77, ...FRAME_BYTES };
      }),
    };
    await expect(frameHandoverExecutors(() => svc)['emit-frame'](OP)).resolves.toEqual({
      receivedAt: 77,
    });
  });

  it('still throws every other failure - a defect stays one', async () => {
    const boom = new Error('network');
    const svc = { sendMessage: vi.fn(async () => Promise.reject(boom)) };
    await expect(frameHandoverExecutors(() => svc)['emit-frame'](OP)).rejects.toBe(boom);
  });

  it('the follower that asked gets FrameNotHandedError(lead-lost), and hands it on no further', async () => {
    tab.leads = false;
    delegateCommitToLeader.mockReset();
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: { unsent: 'lead-lost' } });
    const refused = await sendFrameFromThisTab({ sendMessage: vi.fn() }, GROUP, BYTES).catch(
      (e: unknown) => e
    );
    expect(refused).toBeInstanceOf(FrameNotHandedError);
    expect((refused as FrameNotHandedError).reason).toBe('lead-lost');
    expect(delegateCommitToLeader).toHaveBeenCalledTimes(1);
  });
});
