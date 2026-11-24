// @vitest-environment happy-dom
const state = vi.hoisted(() => ({ follower: true, promoted: false, deviceKey: '' }));
vi.mock('$lib/mls-client/stateAuthority', () => ({
  refusesCommitsHere: () => state.follower,
  promotedSinceLoad: () => state.promoted,
}));
const whenSalonSendable = vi.hoisted(() => vi.fn());
vi.mock('./salonSendGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./salonSendGate')>()),
  whenSalonSendable,
}));
vi.mock('./runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime')>()),
  requireGraineRuntime: () => ({
    deviceKey: () => state.deviceKey,
    storage: {},
    userId: 'alice',
    mlsService: { graineSignatureEngine: () => ({}) },
  }),
  scopeForChannel: (channelId: string) => ({ workspaceId: 'ws-1', channelId }),
  cacheGraineSession: () => {},
}));
// The leader's own seal, past its entry: the key group's epoch is in hand, the seal is a stand-in
// a test can lose the lead inside.
vi.mock('./seedDistribution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./seedDistribution')>()),
  readDistributionEpoch: () => ({ epoch: 1 }),
}));
const sealWithGraineV2 = vi.hoisted(() => vi.fn());
vi.mock('$lib/crypto/graineV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/crypto/graineV2')>()),
  sealWithGraineV2,
}));
// The writes a follower must never reach: an outbound index, a mint, a distribution, a mirror.
const reserveOutboundSlot = vi.hoisted(() => vi.fn());
vi.mock('./sessionManager', () => ({ reserveOutboundSlot }));
const mirrorGraineSeed = vi.hoisted(() => vi.fn());
vi.mock('./graineMirror', () => ({ mirrorGraineSeed }));
const delegateCommitToLeader = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/tabCommitDelegation', () => ({ delegateCommitToLeader }));
const postSealedChannelMessage = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/channelPost', () => ({ postSealedChannelMessage }));

import {
  GraineSealHandoverRefusedError,
  salonSealExecutors,
  sealChannelMessage,
} from './channelSeal';
import { GraineSealUnavailableError } from './sealUnavailable';
import { SalonNotLoadableError, type SalonGateOutcome } from './salonSendGate';
import { openHandedOver, sealForHandover } from '$lib/mls-client/frameFromAnyTab';
import { toBase64 } from '$lib/utils/hex';
import { FollowerTabSendError } from '$lib/mls-client/commitSubmission';
import { StoreWriteRefusedError } from '$lib/db/types';

/**
 * A FOLLOWER TAB SEALS NO SALON MESSAGE ITSELF (2026-11-11): reserving an index writes the shared
 * Graine store, and a rotation mints and distributes a seed with an MLS frame from the follower's
 * forked copy. It hands the payload - sealed under the device key - to the leader and posts what
 * comes back.
 */
describe('sealChannelMessage in a follower tab', () => {
  const sealed = {
    ciphertext: 'c',
    nonce: 'n',
    senderSessionId: 's',
    messageIndex: 4,
    signature: 'sig',
    seedFrame: 'f',
    seedGroupId: 'g',
  };

  beforeEach(() => {
    state.follower = true;
    state.promoted = false;
    state.deviceKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    vi.clearAllMocks();
  });

  it('hands the payload to the leader, sealed, and touches no Graine store', async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: { sealed } });
    const payload = new Uint8Array([9, 8, 7]);

    await expect(sealChannelMessage('channel_abcdef123456', payload)).resolves.toEqual(sealed);

    const op = delegateCommitToLeader.mock.calls[0][0];
    expect(op).toMatchObject({ kind: 'seal-salon-message', channelId: 'abcdef123456' });
    expect(op.payload.cipherText).not.toBe(toBase64(payload));
    // The leader opens exactly what was written.
    expect(await openHandedOver(op.payload)).toEqual(payload);
    expect(reserveOutboundSlot).not.toHaveBeenCalled();
    expect(mirrorGraineSeed).not.toHaveBeenCalled();
  });

  it.each([
    ['leader-gone', 'main-tab-gone'],
    ['leader-unavailable', 'main-tab-unavailable'],
    ['not-delegable', 'main-tab-not-delegable'],
    ['failed', 'main-tab-failed'],
  ] as const)('a leader that answered %s is a typed seal refusal (%s)', async (refusal, reason) => {
    delegateCommitToLeader.mockResolvedValue({ status: 'refused', reason: refusal });
    const sealing = sealChannelMessage('abcdef123456', new Uint8Array([1]));
    await expect(sealing).rejects.toBeInstanceOf(GraineSealHandoverRefusedError);
    await expect(sealing).rejects.toMatchObject({ reason });
  });

  it("the leader's own seal refusal reaches the member under its own reason", async () => {
    delegateCommitToLeader.mockResolvedValue({
      status: 'done',
      value: { unavailable: 'key-group-catching-up' },
    });
    const sealing = sealChannelMessage('abcdef123456', new Uint8Array([1]));
    await expect(sealing).rejects.toBeInstanceOf(GraineSealUnavailableError);
    await expect(sealing).rejects.toMatchObject({ reason: 'key-group-catching-up' });
  });

  it("the leader's OWN salon gate refusing is the gate's typed refusal here, nothing sealed", async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: { gate: 'left' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sealing = sealChannelMessage('abcdef123456', new Uint8Array([1]));
    await expect(sealing).rejects.toBeInstanceOf(SalonNotLoadableError);
    await expect(sealing).rejects.toMatchObject({ reason: 'left' });
  });

  it('a payload the leader could not open (device key changed) is a typed seal refusal', async () => {
    delegateCommitToLeader.mockResolvedValue({
      status: 'done',
      value: { unopened: 'device-key-changed' },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sealing = sealChannelMessage('abcdef123456', new Uint8Array([1]));
    await expect(sealing).rejects.toMatchObject({ reason: 'main-tab-key-changed' });
  });

  it('a leader that lost the lead before sealing is a typed seal refusal, handed on no further', async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: { unsent: 'lead-lost' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sealing = sealChannelMessage('abcdef123456', new Uint8Array([1]));
    await expect(sealing).rejects.toBeInstanceOf(GraineSealUnavailableError);
    await expect(sealing).rejects.toMatchObject({ reason: 'main-tab-lead-lost' });
    expect(delegateCommitToLeader).toHaveBeenCalledTimes(1);
  });

  it('a tab promoted in place, its reload owed, refuses at once and hands nothing over', async () => {
    state.promoted = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sealing = sealChannelMessage('abcdef123456', new Uint8Array([1]));
    await expect(sealing).rejects.toMatchObject({ reason: 'tab-reloading' });
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
  });
});

describe("the leader seals a follower's salon message behind its OWN salon gate", () => {
  beforeEach(() => {
    state.follower = false;
    state.promoted = false;
    state.deviceKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    vi.clearAllMocks();
  });

  it('waits on the gate - nothing sealed meanwhile - and answers its refusal as a value', async () => {
    let decide: (outcome: SalonGateOutcome) => void = () => {};
    const gate = new Promise<SalonGateOutcome>((r) => (decide = r));
    // The executor reaches the gate only after opening the payload (WebCrypto, whose resolution no
    // number of ticks bounds - one `setTimeout(0)` lost that race on a loaded runner, and the
    // executor left running reached the gate inside the NEXT test). The gate's own call says it.
    let reached: () => void = () => {};
    const atGate = new Promise<void>((r) => (reached = r));
    whenSalonSendable.mockImplementation(() => {
      reached();
      return gate;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let answered = false;
    const answer = salonSealExecutors['seal-salon-message']({
      kind: 'seal-salon-message',
      channelId: 'abcdef123456',
      payload: await sealForHandover(new Uint8Array([3])),
    }).finally(() => (answered = true));

    await atGate;
    // A main tab that has not listed its salons yet HOLDS the message, as a single tab does.
    expect(answered).toBe(false);
    expect(whenSalonSendable).toHaveBeenCalledWith('abcdef123456');
    expect(reserveOutboundSlot).not.toHaveBeenCalled();

    decide({ kind: 'refused', reason: 'not-listed' });
    await expect(answer).resolves.toEqual({ gate: 'not-listed' });
    expect(reserveOutboundSlot).not.toHaveBeenCalled();
  });

  it('a payload sealed under a device key since changed is answered unopened, never thrown', async () => {
    const payload = await sealForHandover(new Uint8Array([3]));
    state.deviceKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      salonSealExecutors['seal-salon-message']({
        kind: 'seal-salon-message',
        channelId: 'abcdef123456',
        payload,
      })
    ).resolves.toEqual({ unopened: 'device-key-changed' });
    expect(whenSalonSendable).not.toHaveBeenCalled();
  });
});

/**
 * A LEADER EXECUTOR NEVER DELEGATES, AND THE LEAD CAN LEAVE IT AT ANY AWAIT OF THE RUN (review of
 * #2515). Each case loses the lead at one await, in the order the run reaches them; every one answers
 * `unsent` by value - nothing handed on to whoever leads now, no sealed message handed back to be
 * posted, nothing at error.
 */
describe("the leader's seal of a follower's message when the lead leaves at each await", () => {
  const slot = (minted = false) => ({
    session: {
      sessionId: 'sess-1',
      senderId: 'alice',
      seedB64: 'AAAA',
      distributionFrame: { groupId: 'dist-group', protoB64: 'ZnJhbWU=' },
      v2: { signingSecretKeyB64: 'AAAA' },
    },
    index: 3,
    minted,
    redistributed: false,
  });
  const run = async () =>
    salonSealExecutors['seal-salon-message']({
      kind: 'seal-salon-message',
      channelId: 'abcdef123456',
      payload: await sealForHandover(new Uint8Array([3])),
    });
  const loseTheLead = () => {
    state.follower = true;
  };
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.follower = false;
    state.promoted = false;
    state.deviceKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    vi.clearAllMocks();
    whenSalonSendable.mockResolvedValue({ kind: 'ready' });
    reserveOutboundSlot.mockResolvedValue(slot());
    mirrorGraineSeed.mockResolvedValue(undefined);
    sealWithGraineV2.mockResolvedValue({ ciphertext: 'c', nonce: 'n', signature: 's' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('with the lead kept throughout, seals and hands the message back', async () => {
    await expect(run()).resolves.toMatchObject({ sealed: { messageIndex: 3 } });
    expect(postSealedChannelMessage).not.toHaveBeenCalled();
  });

  // Third review of #4053: adopted from a reloaded page, nobody is left to post it - the leader does.
  it('adopted with the post it carries: sealed AND posted here, with that post', async () => {
    const answer = await salonSealExecutors['seal-salon-message'](
      {
        kind: 'seal-salon-message',
        channelId: 'abcdef123456',
        payload: await sealForHandover(new Uint8Array([3])),
        postIfAdopted: { messageId: 'm-1', silent: true },
      },
      { adopted: true }
    );
    expect(answer).toMatchObject({ sealed: { messageIndex: 3 } });
    expect(postSealedChannelMessage).toHaveBeenCalledWith(
      'abcdef123456',
      expect.objectContaining({ messageIndex: 3 }),
      { messageId: 'm-1', silent: true }
    );
  });

  it('adopted, but the lead left during the seal: nothing posted', async () => {
    sealWithGraineV2.mockImplementation(async () => {
      loseTheLead();
      return { ciphertext: 'c', nonce: 'n', signature: 's' };
    });
    const answer = await salonSealExecutors['seal-salon-message'](
      {
        kind: 'seal-salon-message',
        channelId: 'abcdef123456',
        payload: await sealForHandover(new Uint8Array([3])),
        postIfAdopted: { messageId: 'm-1' },
      },
      { adopted: true }
    );
    expect(answer).toEqual({ unsent: 'lead-lost' });
    expect(postSealedChannelMessage).not.toHaveBeenCalled();
  });

  it("during the gate: refused at the seal's entry, nothing reserved", async () => {
    whenSalonSendable.mockImplementation(async () => {
      loseTheLead();
      return { kind: 'ready' };
    });
    await expect(run()).resolves.toEqual({ unsent: 'lead-lost' });
    expect(reserveOutboundSlot).not.toHaveBeenCalled();
  });

  it('during the reservation, whose write was refused at the put: unsent', async () => {
    reserveOutboundSlot.mockImplementation(async () => {
      loseTheLead();
      throw new StoreWriteRefusedError('the Graine session sess-1');
    });
    await expect(run()).resolves.toEqual({ unsent: 'lead-lost' });
  });

  it("during a seed's distribution, whose send refused it: unsent", async () => {
    reserveOutboundSlot.mockImplementation(async () => {
      loseTheLead();
      throw new FollowerTabSendError('dist-group', 'lead-lost');
    });
    await expect(run()).resolves.toEqual({ unsent: 'lead-lost' });
  });

  it('during the reservation, after its write: the sealed message is dropped, never handed back', async () => {
    reserveOutboundSlot.mockImplementation(async () => {
      const reserved = slot();
      loseTheLead();
      return reserved;
    });
    await expect(run()).resolves.toEqual({ unsent: 'lead-lost' });
  });

  it('during the mirror of a minted seed: the sealed message is dropped', async () => {
    reserveOutboundSlot.mockResolvedValue(slot(true));
    mirrorGraineSeed.mockImplementation(async () => loseTheLead());
    await expect(run()).resolves.toEqual({ unsent: 'lead-lost' });
  });

  it('during the seal itself: the sealed message is dropped', async () => {
    sealWithGraineV2.mockImplementation(async () => {
      loseTheLead();
      return { ciphertext: 'c', nonce: 'n', signature: 's' };
    });
    await expect(run()).resolves.toEqual({ unsent: 'lead-lost' });
  });

  it('a failure that is not the lead leaving still throws', async () => {
    reserveOutboundSlot.mockRejectedValue(new Error('disk full'));
    await expect(run()).rejects.toThrow('disk full');
  });
});

/**
 * THE LEADER'S OWN SEAL, ITS LEAD LOST INSIDE THE RESERVATION: nothing was sealed and nothing posted,
 * so the seal answers the typed "nothing sent" - never a raw store or send refusal the salon send
 * path would read as an outcome unknown.
 */
describe("the leader's OWN seal when the lead leaves during the reservation", () => {
  beforeEach(() => {
    state.follower = false;
    state.promoted = false;
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
    expect(sealWithGraineV2).not.toHaveBeenCalled();
  });

  it.each([
    ['its write refused at the put', () => new StoreWriteRefusedError('the Graine session sess-1')],
    ["its seed's distribution refused", () => new FollowerTabSendError('dist-group', 'lead-lost')],
  ])('%s: a typed seal refusal, main-tab-lead-lost', async (_, refusal) => {
    reserveOutboundSlot.mockImplementation(async () => {
      state.follower = true;
      throw refusal();
    });
    const sealing = sealChannelMessage('abcdef123456', new Uint8Array([1]));
    await expect(sealing).rejects.toBeInstanceOf(GraineSealUnavailableError);
    await expect(sealing).rejects.toMatchObject({ reason: 'main-tab-lead-lost' });
  });

  it('a failure that is not the lead leaving still throws as itself', async () => {
    reserveOutboundSlot.mockRejectedValue(new Error('disk full'));
    await expect(sealChannelMessage('abcdef123456', new Uint8Array([1]))).rejects.toThrow(
      'disk full'
    );
  });
});
