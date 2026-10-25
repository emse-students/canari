// @vitest-environment happy-dom
/**
 * A frame THIS DEVICE sent, delivered back to it, is an own echo - never a loss.
 *
 * MLS never hands a member its own frame back. At the current epoch it says so
 * (`CannotDecryptOwnMessage`); at a PAST epoch the epoch check refuses it first, as a past-epoch
 * application frame, and the pipeline used to read that as a frame this device LOST: a `LOST frame`
 * line blaming a re-join that never happened, then a reconcile asked of a healthy group (campaign
 * GAP-2). The envelope names the sender, so the frame is recognised before MLS is asked.
 *
 * The device is the discriminator: a frame from this account's OTHER device is decryptable and
 * wanted, and must still reach MLS.
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
  reAddIsInFlight: vi.fn(() => false),
  resetReAddCooldowns: vi.fn(),
}));

vi.mock('$lib/utils/chat/historyReconcile', () => ({
  raiseReconcile: vi.fn().mockResolvedValue(true),
  isReconcileRaised: vi.fn().mockReturnValue(false),
  answerAfterMailboxDrained: vi.fn(),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { raiseReconcile } from '$lib/utils/chat/historyReconcile';
import { requestReAdd } from '$lib/utils/chat/recovery';
import { resetSeenCipherCacheForTests } from '$lib/utils/chat/history';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';
import type { IncomingDeliveryMeta } from '../incomingDelivery';

const groupId = '33333333-3333-4333-8333-333333333333';
const ME = 'user-a';
const MY_DEVICE = 'device-test';

/** The marker `mls-core` emits for an application frame of an epoch this device has passed. */
const PAST_EPOCH = 'Process error: past epoch application frame [msg_epoch=2, group_epoch=5]';

function baseDeps() {
  return {
    mlsService: createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
      getDeviceId: vi.fn().mockReturnValue(MY_DEVICE),
      processIncomingMessage: vi.fn().mockRejectedValue(new Error(PAST_EPOCH)),
    }),
    storage: null,
    userId: ME,
    deviceKey: () => 'device-key',
    historyBaseUrl: 'https://hist',
    conversations: createTestConversations([
      [groupId, emptyConversation(groupId, { lifecycle: 'active' })],
    ]),
    messageReactions: createTestMessageReactions(),
    recoveryTimers: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
    loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
}

/**
 * Distinct bytes per delivery: the in-memory frame ring outlives `beforeEach`, and a repeat of the
 * bytes a previous test decrypted would be answered as a duplicate rather than reach the branch.
 */
let nextFrame = 0;

/** Feeds one inbound application frame with its envelope and returns the handler's answer. */
async function deliver(
  deps: ReturnType<typeof baseDeps>,
  sender: string,
  meta: IncomingDeliveryMeta
): Promise<boolean> {
  setupMessageHandler(deps as never);
  const onMsg = (deps.mlsService as never as { onMessage: { mock: { calls: unknown[][] } } })
    .onMessage.mock.calls[0][0] as (
    a: string,
    b: Uint8Array,
    c?: string,
    d?: boolean,
    e?: Uint8Array,
    f?: boolean,
    g?: IncomingDeliveryMeta
  ) => Promise<boolean>;
  return onMsg(sender, new Uint8Array([4, 2, ++nextFrame]), groupId, false, undefined, false, meta);
}

const said = (deps: ReturnType<typeof baseDeps>, needle: string) =>
  vi
    .mocked(deps.log)
    .mock.calls.map(String)
    .filter((line) => line.includes(needle));

describe('a frame this device sent, delivered back to it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetSeenCipherCacheForTests();
  });

  it('at a past epoch: ACKed once, never offered to MLS, no loss counted, no reconcile', async () => {
    const deps = baseDeps();

    expect(
      await deliver(deps, ME, {
        senderDeviceId: MY_DEVICE,
        queuedMessageId: 'q-own',
        channel: 'pull',
      })
    ).toBe(true);

    expect(deps.mlsService.processIncomingMessage).not.toHaveBeenCalled();
    expect(said(deps, 'LOST frame')).toHaveLength(0);
    expect(said(deps, 'Frames are being lost')).toHaveLength(0);
    expect(vi.mocked(raiseReconcile)).not.toHaveBeenCalled();
    expect(vi.mocked(requestReAdd)).not.toHaveBeenCalled();
    expect(said(deps, 'Own frame')).toHaveLength(1);
  });

  it('is recognised whatever the case of the user id the envelope carries', async () => {
    const deps = baseDeps();

    await deliver(deps, 'USER-A', { senderDeviceId: MY_DEVICE, channel: 'live' });

    expect(deps.mlsService.processIncomingMessage).not.toHaveBeenCalled();
  });
});

describe('a frame this device did NOT send still reaches MLS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetSeenCipherCacheForTests();
  });

  it("from this account's OTHER device: decrypted and shown as before", async () => {
    const deps = baseDeps();
    const { encodeAppMessage, mkText } = await import('$lib/proto/codec');
    vi.mocked(deps.mlsService.processIncomingMessage).mockResolvedValue({
      plaintext: encodeAppMessage(mkText('from my phone')),
    } as never);

    expect(
      await deliver(deps, ME, { senderDeviceId: 'device-other', queuedMessageId: 'q-1' })
    ).toBe(true);

    expect(deps.mlsService.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(deps.addMessageToChat).toHaveBeenCalledTimes(1);
    expect(said(deps, 'Own frame')).toHaveLength(0);
  });

  it('from another member, unreadable at a past epoch: still a loss, still reconciled', async () => {
    const deps = baseDeps();

    expect(await deliver(deps, 'user-b', { senderDeviceId: MY_DEVICE })).toBe(true);

    expect(deps.mlsService.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(said(deps, 'LOST frame')).toHaveLength(1);
    expect(vi.mocked(raiseReconcile)).toHaveBeenCalledWith(
      deps.mlsService,
      groupId,
      expect.any(Function)
    );
  });

  it('with no device on the envelope: never taken for ours', async () => {
    const deps = baseDeps();

    await deliver(deps, ME, { queuedMessageId: 'q-old' });

    expect(deps.mlsService.processIncomingMessage).toHaveBeenCalledTimes(1);
  });
});
