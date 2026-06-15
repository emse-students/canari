import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  saveMlsStatePlain: vi.fn().mockResolvedValue(undefined),
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
  recoverDeadGroup: vi.fn().mockResolvedValue(undefined),
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
  reboot: vi.fn().mockResolvedValue(undefined),
}));

import { setupMessageHandler } from './setupMessageHandler';
import * as codec from '$lib/proto/codec';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

describe('setupMessageHandler (MLS inbound + channel events)', () => {
  const groupId = '11111111-1111-4111-8111-111111111111';

  function baseDeps(overrides: Record<string, unknown> = {}) {
    const conversations = createTestConversations([
      [groupId, emptyConversation(groupId, { isReady: false })],
    ]);
    const mls = createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
    });
    return {
      mlsService: mls,
      storage: null,
      userId: 'user-a',
      pin: 'pin',
      historyBaseUrl: 'https://hist',
      conversations,
      messageReactions: createTestMessageReactions(),
      getSelectedContact: () => null,
      setSelectedContact: vi.fn(),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      addMessageToChat: vi.fn().mockResolvedValue(undefined),
      loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
      ...overrides,
    };
  }

  it('registers onMessage and onChannelEvent on the MLS service', () => {
    const deps = baseDeps();
    setupMessageHandler(deps as any);
    expect(deps.mlsService.onMessage).toHaveBeenCalled();
    expect(typeof (deps.mlsService as any).onChannelEvent).toBe('function');
  });

  it('propagates channel.member.joined to callback', async () => {
    const onChannelMemberJoined = vi.fn();
    const deps = baseDeps({ onChannelMemberJoined });
    setupMessageHandler(deps as any);
    const mlsAny = deps.mlsService as any;
    await mlsAny.onChannelEvent({
      type: 'channel.member.joined',
      data: { channelId: 'c1', channelName: 'general', workspaceId: 'ws1' },
    });
    expect(onChannelMemberJoined).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c1', channelName: 'general', workspaceId: 'ws1' })
    );
  });

  it('epoch_rejected envoie un welcome_request (requestReAdd)', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    setupMessageHandler(deps as any);
    await mls.onChannelEvent({
      type: 'epoch_rejected',
      data: { groupId, currentEpoch: 7 },
    });
    // Le nouveau comportement : requestReAdd est appelé (qui envoie sendWelcomeRequest)
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(
      groupId,
      expect.anything(),
      expect.anything()
    );
  });

  it('processes Welcome for known placeholder conversation (not ready)', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.processWelcome = vi.fn().mockResolvedValue(undefined);
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const ok = await onMsg('peer-user', new Uint8Array([1, 2]), groupId, true, undefined, false);
    expect(ok).toBe(true);
    expect(mls.processWelcome).toHaveBeenCalled();
    expect(mls.registerMember).toHaveBeenCalledWith(groupId, 'user-a');
    expect(deps.conversations.get(groupId)?.isReady).toBe(true);
  });

  it('routes plaintext channel.message.created to addMessageToChat', async () => {
    const channelKey = 'channel_chan-99';
    const conversations = createTestConversations([
      [channelKey, emptyConversation(channelKey, { isReady: true, conversationType: 'channel' })],
    ]);
    const deps = baseDeps({ conversations });
    setupMessageHandler(deps as any);
    const mls = deps.mlsService as any;
    await mls.onChannelEvent({
      type: 'channel.message.created',
      data: {
        channelId: 'chan-99',
        senderId: 'u-sender',
        plaintext: 'hi-channel',
        createdAt: new Date('2020-01-01').toISOString(),
        messageId: 'ext-1',
      },
    });
    expect(deps.addMessageToChat).toHaveBeenCalledWith(
      'u-sender',
      expect.any(String),
      channelKey,
      expect.objectContaining({ messageId: 'ext-1' })
    );
  });

  it('propagates channel.member.kicked', async () => {
    const onChannelMemberKicked = vi.fn();
    const deps = baseDeps({ onChannelMemberKicked });
    setupMessageHandler(deps as any);
    await (deps.mlsService as any).onChannelEvent({
      type: 'channel.member.kicked',
      data: { channelId: 'c2', kickedBy: 'admin' },
    });
    expect(onChannelMemberKicked).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c2', kickedBy: 'admin' })
    );
  });

  it('logs when channel.message.created targets unknown channel', async () => {
    const deps = baseDeps();
    setupMessageHandler(deps as any);
    await (deps.mlsService as any).onChannelEvent({
      type: 'channel.message.created',
      data: {
        channelId: 'unknown',
        senderId: 'x',
        plaintext: 'n',
        createdAt: new Date().toISOString(),
      },
    });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Canal inconnu'));
  });

  it('propagates channel.updated and workspace.updated', async () => {
    const onChannelUpdated = vi.fn();
    const onWorkspaceUpdated = vi.fn();
    const deps = baseDeps({ onChannelUpdated, onWorkspaceUpdated });
    setupMessageHandler(deps as any);
    const mls = deps.mlsService as any;
    await mls.onChannelEvent({
      type: 'channel.updated',
      data: { channelId: 'c1', name: 'new', workspaceId: 'w1' },
    });
    await mls.onChannelEvent({
      type: 'workspace.updated',
      data: { workspaceId: 'w1', imageMediaId: 'img1' },
    });
    expect(onChannelUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c1', name: 'new' })
    );
    expect(onWorkspaceUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', imageMediaId: 'img1' })
    );
  });

  it('Welcome (NoMatchingKeyPackage) → republie le matériel de clé + sendWelcomeRequest', async () => {
    // groupId unique : le compteur d'échecs NoMatchingKeyPackage est module-level.
    const gid = 'a1111111-1111-4111-8111-111111111111';
    const deps = baseDeps({
      conversations: createTestConversations([[gid, emptyConversation(gid, { isReady: false })]]),
    });
    const mls = deps.mlsService as any;
    mls.processWelcome = vi
      .fn()
      .mockRejectedValue(new Error('NoMatchingKeyPackage - key consumed'));
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), gid, true, undefined);
    expect(ok).toBe(true);
    // 1ʳᵉ détection : on republie un matériel de clé frais puis on redemande un Welcome.
    expect(mls.republishKeyMaterial).toHaveBeenCalledWith('pin');
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith(gid);
  });

  it('Welcome (NoMatchingKeyPackage) répété → escalade requestReAdd après le seuil', async () => {
    const recovery = await import('$lib/utils/chat/recovery');
    vi.mocked(recovery.requestReAdd).mockClear();
    const gid = 'a2222222-2222-4222-8222-222222222222';
    const deps = baseDeps({
      conversations: createTestConversations([[gid, emptyConversation(gid, { isReady: false })]]),
    });
    const mls = deps.mlsService as any;
    mls.processWelcome = vi.fn().mockRejectedValue(new Error('NoMatchingKeyPackage'));
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    // 3 tentatives = welcome_request ; la 4ᵉ (au-delà du seuil) escalade en requestReAdd.
    for (let i = 0; i < 3; i++) await onMsg('peer', new Uint8Array([1]), gid, true, undefined);
    expect(recovery.requestReAdd).not.toHaveBeenCalled();
    await onMsg('peer', new Uint8Array([1]), gid, true, undefined);
    expect(recovery.requestReAdd).toHaveBeenCalledWith(gid, expect.anything(), expect.anything());
  });

  it('Welcome (GroupAlreadyExists) → noop, ACK', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.processWelcome = vi.fn().mockRejectedValue(new Error('GroupAlreadyExists for this id'));
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, true, undefined);
    expect(ok).toBe(true);
    // Pas de sendWelcomeRequest ni d'erreur levée
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('Welcome redélivré pour groupe déjà détenu → idempotent, pas de re-join ni welcome_request', async () => {
    // Régression : un Welcome redélivré (requeue serveur après restart) pour un groupe
    // qu'on tient déjà localement ne doit PAS lancer processWelcome (qui échouerait sur
    // NoMatchingKeyPackage et déclencherait un kick+ré-ajout destructeur côté invitant).
    const onGroupReady = vi.fn();
    const deps = baseDeps({ onGroupReady });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processWelcome = vi.fn().mockResolvedValue(groupId);
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, true, undefined);
    expect(ok).toBe(true);
    expect(mls.processWelcome).not.toHaveBeenCalled();
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(onGroupReady).toHaveBeenCalledWith(groupId);
  });

  it('commit groupe inconnu → bufferisé + welcome_request envoyé', async () => {
    const unknownGroupId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    // Groupe absent du WASM local
    mls.getLocalGroups = vi.fn().mockReturnValue([]);
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const result = await onMsg('peer', new Uint8Array([1]), unknownGroupId, false, undefined, true);
    // false → message gardé en queue côté serveur (pending buffer)
    expect(result).toBe(false);
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith(unknownGroupId);
  });

  it('buffer timeout 10s → requestReAdd déclenché', async () => {
    vi.useFakeTimers();
    const unknownGroupId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([]);
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    await onMsg('peer', new Uint8Array([1]), unknownGroupId, false, undefined, true);

    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.advanceTimersByTime(10_000);
    await Promise.resolve(); // flush microtasks
    await Promise.resolve();

    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(
      unknownGroupId,
      expect.anything(),
      expect.anything()
    );
    vi.useRealTimers();
  });

  it('groupe connu, déchiffrement échoue → requestReAdd + ACK', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processIncomingMessage = vi.fn().mockRejectedValue(new Error('WrongEpoch'));
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, false, undefined, false);
    expect(ok).toBe(true);
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(
      groupId,
      expect.anything(),
      expect.anything()
    );
  });

  it('delivers decrypted app text for known group (non-welcome)', async () => {
    vi.mocked(codec.decodeAppMessage).mockReturnValueOnce({
      text: { body: 'hello-dm' },
      messageId: 'mid-dm',
    } as any);
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.processIncomingMessage = vi.fn().mockResolvedValue(new Uint8Array([9, 9]));
    // Le groupe doit être dans getLocalGroups() pour être traité (WASM = source de vérité)
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, false, undefined, false);
    expect(ok).toBe(true);
    expect(mls.processIncomingMessage).toHaveBeenCalledWith(groupId, expect.any(Uint8Array));
    expect(deps.addMessageToChat).toHaveBeenCalledWith(
      'peer',
      'rendered',
      groupId,
      expect.objectContaining({})
    );
  });

  it('GAP_QUEUED persistant au-delà du seuil → forget + escalade requestReAdd', async () => {
    vi.useFakeTimers();
    const gid = 'b3333333-3333-4333-8333-333333333333';
    const deps = baseDeps({
      conversations: createTestConversations([[gid, emptyConversation(gid, { isReady: true })]]),
    });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([gid]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error(`GAP_QUEUED:${gid}:msg_epoch=4:group_epoch=2`));
    mls.forgetGroup = vi.fn();
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;

    // 1ʳᵉ occurrence : arme l'escalade, ACK, pas encore de forget.
    const ok1 = await onMsg('peer', new Uint8Array([1]), gid, false, undefined, false);
    expect(ok1).toBe(true);
    expect(mls.forgetGroup).not.toHaveBeenCalled();

    // Au-delà du seuil → forget + welcome_request (via onOutOfSync → requestReAdd).
    vi.advanceTimersByTime(31_000);
    await onMsg('peer', new Uint8Array([1]), gid, false, undefined, false);
    expect(mls.forgetGroup).toHaveBeenCalledWith(gid);
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(gid, expect.anything(), expect.anything());
    vi.useRealTimers();
  });
});
