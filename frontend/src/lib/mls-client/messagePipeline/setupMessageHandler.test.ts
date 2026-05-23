import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
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
}));

import { setupMessageHandler } from './setupMessageHandler';
import { saveMlsState } from '$lib/utils/hex';
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
    const mls = createMlsServiceStub();
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

  it('epoch_rejected triggers forgetGroup, saveState, sendReinviteRequest', async () => {
    const deps = baseDeps();
    setupMessageHandler(deps as any);
    const mls = deps.mlsService as any;
    await mls.onChannelEvent({
      type: 'epoch_rejected',
      data: { groupId, currentEpoch: 7 },
    });
    expect(mls.forgetGroup).toHaveBeenCalledWith(groupId, 7);
    expect(mls.saveState).toHaveBeenCalledWith('pin');
    expect(vi.mocked(saveMlsState)).toHaveBeenCalled();
    expect(mls.sendReinviteRequest).toHaveBeenCalledWith(groupId);
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

  it('delivers decrypted app text for known group (non-welcome)', async () => {
    vi.mocked(codec.decodeAppMessage).mockReturnValueOnce({
      text: { body: 'hello-dm' },
      messageId: 'mid-dm',
    } as any);
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.processIncomingMessage = vi.fn().mockResolvedValue(new Uint8Array([9, 9]));
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
});
