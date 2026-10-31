// @vitest-environment happy-dom
/**
 * A REFUSED ADMISSION IS A PROOF, AND EVERY RECOVERY WOULD UNDO IT.
 *
 * `mls-core` refused a commit bringing a new user in on their own
 * (`frontend/mls-core/tests/admission_policy.rs`). The server, if it is the attacker, has accepted
 * that commit and moved the group on - so a commit replay is refused again, and the external join
 * after it rebuilds this device from a GroupInfo that CONTAINS the intruder. The pipeline therefore
 * ACKs the frame, alerts, freezes the group, and starts no recovery.
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

describe('setupMessageHandler - a refused admission', () => {
  it('ACKs it, freezes the group, tells the listener and asks for no recovery', async () => {
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    const { isFrozenByAdmissionRefusal, resetAdmissionFreezes, setAdmissionFreezeListener } =
      await import('$lib/utils/chat/admissionFreeze');
    resetAdmissionFreezes();
    const listener = vi.fn();
    setAdmissionFreezeListener(listener);
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('ADMISSION_REFUSED: mallory:dev7 entered by external commit'));
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    const acked = await cb('peer', new Uint8Array([6, 6, 6]), groupId, false, undefined, false);

    // ACKed: the frame is a proof already recorded, and leaving it queued replays the refusal.
    expect(acked).toBe(true);
    expect(isFrozenByAdmissionRefusal(groupId)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ groupId, entrant: 'mallory:dev7' })
    );
    expect(vi.mocked(requestReAdd)).not.toHaveBeenCalled();
    const said = (deps.log as any).mock.calls.flat().join(' ');
    expect(said).not.toContain('re-add');
    expect(said).not.toContain('Out-of-sync');
  });

  it('does not tell the listener twice for the same group', async () => {
    const { resetAdmissionFreezes, setAdmissionFreezeListener } =
      await import('$lib/utils/chat/admissionFreeze');
    resetAdmissionFreezes();
    const listener = vi.fn();
    setAdmissionFreezeListener(listener);
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('ADMISSION_REFUSED: mallory:dev7 entered by external commit'));
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    await cb('peer', new Uint8Array([6, 6, 6]), groupId, false, undefined, false);
    await cb('peer', new Uint8Array([6, 6, 7]), groupId, false, undefined, false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('acknowledges the frames of a frozen group without recovering them: an epoch gap is not escalated', async () => {
    // The server moved the group on past the refused commit, so every later frame reads as an epoch
    // gap - and the escalation of an epoch gap is the forget-and-rejoin that rebuilds this device
    // from the state holding the person.
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    const { freezeForAdmissionRefusal, resetAdmissionFreezes } =
      await import('$lib/utils/chat/admissionFreeze');
    resetAdmissionFreezes();
    freezeForAdmissionRefusal(groupId, 'mallory:dev7');
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('Process error: epoch gap [msg_epoch=5, group_epoch=4]'));
    mls.forgetGroup = vi.fn();
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    const acked = await cb('peer', new Uint8Array([6, 6, 6]), groupId, false, undefined, false);

    expect(acked).toBe(true);
    expect(mls.forgetGroup).not.toHaveBeenCalled();
    expect(vi.mocked(requestReAdd)).not.toHaveBeenCalled();
  });

  it('control: the same epoch gap on a group that is not frozen is not acknowledged away', async () => {
    // Without this, the case above would pass on a pipeline that ACKs every gap.
    const { resetAdmissionFreezes } = await import('$lib/utils/chat/admissionFreeze');
    resetAdmissionFreezes();
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
    expect(said).not.toContain('frozen group');
  });
});
