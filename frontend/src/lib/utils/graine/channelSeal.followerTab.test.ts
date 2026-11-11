// @vitest-environment happy-dom
const state = vi.hoisted(() => ({ follower: true, deviceKey: '' }));
vi.mock('$lib/mls-client/stateAuthority', () => ({ refusesCommitsHere: () => state.follower }));
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

import { GraineSealHandoverRefusedError, sealChannelMessage } from './channelSeal';
import { GraineSealUnavailableError } from './sealUnavailable';
import { openHandedOver } from '$lib/mls-client/frameFromAnyTab';
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
});
