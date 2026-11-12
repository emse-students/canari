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
  requireGraineRuntime: () => ({ deviceKey: () => state.deviceKey }),
}));
// The writes a follower must never reach: an outbound index, a mint, a distribution, a mirror.
const reserveOutboundSlot = vi.hoisted(() => vi.fn());
vi.mock('./sessionManager', () => ({ reserveOutboundSlot }));
const mirrorGraineSeed = vi.hoisted(() => vi.fn());
vi.mock('./graineMirror', () => ({ mirrorGraineSeed }));
const delegateCommitToLeader = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/tabCommitDelegation', () => ({ delegateCommitToLeader }));

import {
  GraineSealHandoverRefusedError,
  salonSealExecutors,
  sealChannelMessage,
} from './channelSeal';
import { GraineSealUnavailableError } from './sealUnavailable';
import { SalonNotLoadableError, type SalonGateOutcome } from './salonSendGate';
import { openHandedOver, sealForHandover } from '$lib/mls-client/frameFromAnyTab';
import { toBase64 } from '$lib/utils/hex';

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
    // The executor reaches the gate only after it opens the payload (a real AES-GCM decrypt), so the
    // test waits on the gate's CALL, never on a turn of the event loop: one `setTimeout(0)` was not
    // always enough in a loaded shard, and the late call then landed in the next test.
    let gateAsked: () => void = () => {};
    const asked = new Promise<void>((r) => (gateAsked = r));
    whenSalonSendable.mockImplementation(() => {
      gateAsked();
      return new Promise<SalonGateOutcome>((r) => (decide = r));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let answered = false;
    const answer = salonSealExecutors['seal-salon-message']({
      kind: 'seal-salon-message',
      channelId: 'abcdef123456',
      payload: await sealForHandover(new Uint8Array([3])),
    }).finally(() => (answered = true));

    await asked;
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
