/**
 * A frame lost to a rewound sender must trigger a RECONCILIATION, and nothing durable may stop it.
 *
 * The defect this pins shipped and was measured on prod (2026-08-10): the receiver logged twelve
 * `LOST frame` lines and solicited nothing, because `handleConsumedGeneration` opened with
 * `if (isAwaitingHistory(...)) return`. That marker was DURABLE - it survived reloads and sessions
 * and was cleared only by an empty diff - so the reasoning "while it stands, this group is already
 * being reconciled" quietly became "a group that has ever been broken never asks again from this
 * path", and recovery fell back to the fifteen-minute sweep.
 *
 * The marker is gone. Deciding whether asking would duplicate one belongs to `reconcileGroup` alone,
 * which coalesces a burst and forgets it - nothing survives the session to gate a later edge.
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
  resetReAddCooldowns: vi.fn(),
}));

vi.mock('$lib/crypto/ChannelKeyVault', () => ({
  channelKeyManager: {
    getVault: vi.fn(() => ({ rotateKey: vi.fn().mockResolvedValue(undefined) })),
    decryptMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  },
}));

vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class MockChannelService {
    markKeyDistributionReceived = vi.fn().mockResolvedValue(undefined);
    ackKeyDistribution = vi.fn().mockResolvedValue(undefined);
    getChannelKeyBootstrap = vi.fn();
    sendMessage = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('$lib/utils/chat/historyReconcile', () => ({
  reconcileGroup: vi.fn().mockResolvedValue(true),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { reconcileGroup } from '$lib/utils/chat/historyReconcile';
import { requestReAdd } from '$lib/utils/chat/recovery';
import { frameFingerprint } from '../inboundFrameLedger';
import { markHistoryFrameConsumed, resetSeenCipherCacheForTests } from '$lib/utils/chat/history';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

const groupId = '22222222-2222-4222-8222-222222222222';

/** The exact OpenMLS wording `classifyIncomingDecryptError` keys on. */
const SECRET_REUSE = 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))';

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    mlsService: createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
      // The group is KNOWN locally - this is the rewound-sender case, not a missing Welcome.
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
      processIncomingMessage: vi.fn().mockRejectedValue(new Error(SECRET_REUSE)),
    }),
    storage: null,
    userId: 'user-a',
    deviceKeyB64: 'device-key',
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
    ...overrides,
  };
}

/** Feeds one inbound application frame and returns what the handler answered. */
async function deliver(deps: ReturnType<typeof baseDeps>, body: number[]): Promise<boolean> {
  setupMessageHandler(deps as never);
  const onMsg = (deps.mlsService as never as { onMessage: { mock: { calls: unknown[][] } } })
    .onMessage.mock.calls[0][0] as (
    a: string,
    b: Uint8Array,
    c?: string,
    d?: boolean,
    e?: Uint8Array,
    f?: boolean
  ) => Promise<boolean>;
  return onMsg('peer-user', new Uint8Array(body), groupId, false, undefined, false);
}

/**
 * The other half of the same question, and the one that was missing (WP-FALSELOSS-2).
 *
 * A frame can have its generation consumed by the ARCHIVE REPLAY as well as by live delivery, and
 * the two leave their marks in different places: the replay in the durable per-group set, live
 * delivery in that same set AND in an in-memory ring. Consulting only the ring - which is what this
 * handler did - means a frame the replay decrypted seconds earlier arrives on the wire, matches
 * nothing, and is reported LOST for a message the user is looking at.
 */
describe('a frame this device has already read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetSeenCipherCacheForTests();
  });

  it('is a silent duplicate, and asks for no repair, when the archive replay consumed it', async () => {
    const body = [5, 6, 7];
    // Exactly what the replay writes when a frame of its page decrypts: the frame's own bytes, in
    // the durable set. It is keyed on the bytes because no identifier survives both paths.
    markHistoryFrameConsumed('user-a', groupId, frameFingerprint(new Uint8Array(body)));
    const deps = baseDeps();

    expect(await deliver(deps, body)).toBe(true);

    expect(vi.mocked(reconcileGroup)).not.toHaveBeenCalled();
  });

  it('still reconciles when the mark belongs to a DIFFERENT frame - the trigger is not being suppressed', async () => {
    // The distinction the whole ledger exists to make, and the reason this is not a mute button: a
    // consumed generation with bytes nobody has read is a real loss, and it must still ask.
    markHistoryFrameConsumed('user-a', groupId, frameFingerprint(new Uint8Array([1, 1, 1])));
    const deps = baseDeps();

    expect(await deliver(deps, [5, 6, 7])).toBe(true);

    expect(vi.mocked(reconcileGroup)).toHaveBeenCalledWith(
      deps.mlsService,
      groupId,
      expect.any(Function)
    );
  });
});

describe('a frame lost to a rewound sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetSeenCipherCacheForTests();
  });

  it('reconciles the conversation, with nothing durable able to suppress it', async () => {
    const deps = baseDeps();

    expect(await deliver(deps, [9, 9, 9])).toBe(true);

    // The regression: with a marker consulted as "have I already asked", this was never reached.
    expect(vi.mocked(reconcileGroup)).toHaveBeenCalledWith(
      deps.mlsService,
      groupId,
      expect.any(Function)
    );
  });

  it('still ACKs the frame - it can never decrypt, so retrying it forever is dead weight', async () => {
    expect(await deliver(baseDeps(), [7, 7])).toBe(true);
  });
});

/**
 * The same policy, reached from the OTHER end of the ratchet.
 *
 * `mls-core` answered `Ok(None)` for an application frame from an epoch already past, which reads
 * as "no application payload" - indistinguishable from a commit echo - so none of the above ran
 * and the loss left no trace at all. Measured on prod 2026-08-11 (HEAL-W2): the message was ACKed
 * off the server, and the only line it produced was one a routine handshake also produces.
 */
describe('a frame from an epoch whose secrets are gone', () => {
  /** The marker `mls-core` emits, and the only thing the TS side ever sees of that decision. */
  const PAST_EPOCH = 'Process error: past epoch application frame [msg_epoch=1, group_epoch=4]';

  const pastEpochDeps = () =>
    baseDeps({
      mlsService: createMlsServiceStub({
        getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
        getLocalGroups: vi.fn().mockReturnValue([groupId]),
        processIncomingMessage: vi.fn().mockRejectedValue(new Error(PAST_EPOCH)),
      }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetSeenCipherCacheForTests();
  });

  it('reconciles and ACKs, exactly like a consumed generation', async () => {
    const deps = pastEpochDeps();

    expect(await deliver(deps, [4, 4, 4])).toBe(true);

    expect(vi.mocked(reconcileGroup)).toHaveBeenCalledWith(
      deps.mlsService,
      groupId,
      expect.any(Function)
    );
  });

  it('never re-adds: the group is healthy, only this one frame is unreadable', async () => {
    // A re-add destroys a valid membership, and it would recover nothing - the plaintext is gone
    // locally whatever we do. Only a member still holding the message can produce it again.
    await deliver(pastEpochDeps(), [4, 4, 4]);
    expect(vi.mocked(requestReAdd)).not.toHaveBeenCalled();
  });
});
