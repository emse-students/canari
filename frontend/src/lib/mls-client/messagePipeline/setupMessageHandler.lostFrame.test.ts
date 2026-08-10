/**
 * A frame lost to a rewound sender must SOLICIT, and the durable marker must not be what stops it.
 *
 * The defect this pins shipped and was measured on prod (2026-08-10): the receiver logged twelve
 * `LOST frame` lines and solicited nothing, because `handleConsumedGeneration` opened with
 * `if (isAwaitingHistory(...)) return`. The marker is DURABLE - it survives reloads and sessions and
 * is cleared only by an empty diff - so the reasoning "while it stands, this group is already being
 * reconciled" quietly became "a group that has ever been broken never asks again from this path",
 * and recovery fell back to the fifteen-minute sweep.
 *
 * Deciding whether asking would duplicate an attempt belongs to `solicitHistory` alone, which reads
 * the only fact that answers it: is one scheduled, or inside its response window.
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

vi.mock('$lib/utils/chat/historySolicit', () => ({
  solicitHistory: vi.fn(),
}));

vi.mock('$lib/utils/chat/awaitingHistoryRegistry', () => ({
  // The whole point: this stands from a PREVIOUS session, as it does on any device that has ever
  // lost a frame in this group.
  isAwaitingHistory: vi.fn(() => true),
  markAwaitingHistory: vi.fn(),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { solicitHistory } from '$lib/utils/chat/historySolicit';
import { markAwaitingHistory } from '$lib/utils/chat/awaitingHistoryRegistry';
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

describe('a frame lost to a rewound sender', () => {
  beforeEach(() => vi.clearAllMocks());

  it('solicits a history diff even though the durable marker already stands', async () => {
    const deps = baseDeps();

    expect(await deliver(deps, [9, 9, 9])).toBe(true);

    // The regression: with the marker consulted as "have I already asked", this was never reached.
    expect(vi.mocked(solicitHistory)).toHaveBeenCalledWith(
      deps.mlsService,
      groupId,
      expect.any(Function)
    );
    // Re-marked rather than skipped: the evidence is refreshed, it just does not gate the request.
    expect(vi.mocked(markAwaitingHistory)).toHaveBeenCalledWith(
      'user-a',
      groupId,
      'unreadable-frames'
    );
  });

  it('still ACKs the frame - it can never decrypt, so retrying it forever is dead weight', async () => {
    expect(await deliver(baseDeps(), [7, 7])).toBe(true);
  });
});
