// @vitest-environment happy-dom
/**
 * A FREEZE WRITTEN BY A DEV BUILD OF #2815 DEAFENS NOTHING.
 *
 * #2815 stored a device-wide list of "frozen" groups in localStorage (`canari_admission_frozen`)
 * and ACKed and dropped every later frame of each. The owner disarmed the rule on 2026-10-31 and the
 * freeze is gone with it: nothing reads that key any more, so a device that ran such a build follows
 * its conversations exactly like any other - its frames are rendered, and an epoch gap climbs the
 * ordinary recovery ladder instead of being acknowledged away.
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
  fromBase64: vi.fn(() => new Uint8Array([1])),
}));

vi.mock('$lib/proto/codec', () => ({
  decodeAppMessage: vi.fn(() => ({ text: { body: 'hello-from-proto' }, messageId: 'mid-1' })),
  encodeAppMessage: vi.fn(() => new Uint8Array([1])),
  mkSystem: vi.fn(() => new Uint8Array([2])),
}));

vi.mock('$lib/envelope', () => ({
  serializeEnvelope: (x: unknown) => `env:${JSON.stringify(x)}`,
  mkTextEnvelope: (t: string) => ({ plain: t }),
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

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: vi.fn((id: string) => `Name(${id})`),
}));

vi.mock('$lib/utils/chat/messageUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/messageUtils')>();
  return {
    ...actual,
    appMsgToEnvelope: vi.fn(() => ({ content: 'rendered', options: { messageId: 'mid-1' } })),
  };
});

vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
  // Default `false`: the pipeline asks this about every Remove commit, and the suite's subject is
  // the eviction path. The re-admission case has its own tests in `eviction.test.ts`.
  reAddIsInFlight: vi.fn(() => false),
  resetReAddCooldowns: vi.fn(),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

const groupId = '11111111-1111-4111-8111-111111111111';

function baseDeps(overrides: Record<string, unknown> = {}) {
  const conversations = createTestConversations([
    [groupId, emptyConversation(groupId, { lifecycle: 'active' })],
  ]);
  const mls = createMlsServiceStub({
    getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
  });
  return {
    mlsService: mls,
    storage: null,
    userId: 'user-a',
    deviceKey: () => 'device-key',
    historyBaseUrl: 'https://hist',
    conversations,
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

/** What a dev build of #2815 left behind: `groupId` recorded as frozen. */
function storeLegacyFreeze(): void {
  localStorage.setItem(
    'canari_admission_frozen',
    JSON.stringify([{ groupId, entrant: 'mallory:dev7', at: 1_700_000_000_000 }])
  );
}

describe('setupMessageHandler - a freeze stored by an earlier build', () => {
  beforeEach(() => localStorage.clear());

  it('renders a readable frame of the group', async () => {
    storeLegacyFreeze();
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processIncomingMessage = vi
      .fn()
      .mockResolvedValue({ plaintext: new Uint8Array([1]), author: 'unsigned' });
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    const acked = await cb('peer', new Uint8Array([6, 6, 6]), groupId, false, undefined, false);

    expect(acked).toBe(true);
    expect(deps.addMessageToChat).toHaveBeenCalled();
  });

  it('climbs the epoch-gap ladder instead of acknowledging the frame away', async () => {
    storeLegacyFreeze();
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('Process error: epoch gap [msg_epoch=5, group_epoch=4]'));
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    await cb('peer', new Uint8Array([6, 6, 6]), groupId, false, undefined, false);

    const said = (deps.log as any).mock.calls.flat().join(' ');
    expect(said).toContain('[GAP]');
    expect(said).not.toContain('frozen group');
    expect(said).not.toContain('[ADMISSION]');
  });
});
