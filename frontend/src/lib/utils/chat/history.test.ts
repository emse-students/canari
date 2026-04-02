import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replayConversationHistory } from './history';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';

const decodeAppMessageMock = vi.fn();

vi.mock('$lib/proto/codec', () => ({
  decodeAppMessage: (...args: unknown[]) => decodeAppMessageMock(...args),
  MediaKind: {
    MEDIA_IMAGE: 1,
    MEDIA_VIDEO: 2,
    MEDIA_AUDIO: 3,
  },
}));

function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
  return {
    init: vi.fn(),
    createGroup: vi.fn(),
    createRemoteGroup: vi.fn(),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([0xaa])),
    generateKeyPackage: vi.fn(),
    addMember: vi.fn(),
    addMembersBulk: vi.fn(),
    processWelcome: vi.fn(),
    sendMessage: vi.fn(),
    processIncomingMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    connect: vi.fn(),
    fetchUserDevices: vi.fn(),
    publishKeyPackage: vi.fn(),
    sendWelcome: vi.fn(),
    sendCommit: vi.fn(),
    registerMember: vi.fn(),
    fetchHistory: vi.fn().mockResolvedValue([]),
    getDeviceId: vi.fn().mockReturnValue('dev-main'),
    getLocalGroups: vi.fn().mockReturnValue([]),
    renameGroup: vi.fn(),
    deleteGroupOnServer: vi.fn(),
    removeMemberFromServer: vi.fn(),
    removeMember: vi.fn(),
    getGroupMembers: vi.fn(),
    getUserGroups: vi.fn(),
    exportSecret: vi.fn(),
    onMessage: vi.fn(),
    onDisconnect: vi.fn(),
    sendSyncRequest: vi.fn(),
    onSyncRequest: vi.fn(),
    ...overrides,
  } as unknown as IMlsService;
}

describe('replayConversationHistory', () => {
  beforeEach(() => {
    decodeAppMessageMock.mockReset();
    localStorage.clear();
  });

  it('ignore WrongEpoch et SecretReuseError sans interrompre le replay', async () => {
    const mls = makeMls({
      fetchHistory: vi.fn().mockResolvedValue([
        { sender_id: 'alice', content: btoa('x'), timestamp: Date.now() },
        { sender_id: 'alice', content: btoa('y'), timestamp: Date.now() + 1 },
      ]),
      processIncomingMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('WrongEpoch'))
        .mockRejectedValueOnce(new Error('SecretReuseError')),
    });

    const addMessageToChat = vi.fn();

    await replayConversationHistory({
      mlsService: mls,
      groupId: 'g-1',
      contactName: 'dm_1',
      userId: 'jolan',
      pin: '1234',
      addMessageToChat,
      getConversation: () => undefined,
      setConversation: vi.fn(),
      messageReactions: new Map(),
      log: vi.fn(),
    });

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(mls.saveState).not.toHaveBeenCalled();
  });

  it('rejoue memberAdded en message systeme lisible', async () => {
    const mls = makeMls({
      fetchHistory: vi
        .fn()
        .mockResolvedValue([{ sender_id: 'alice', content: btoa('x'), timestamp: Date.now() }]),
    });

    decodeAppMessageMock.mockReturnValue({
      system: {
        event: 'memberAdded',
        data: JSON.stringify({ newUsers: ['bob', 'charlie'] }),
      },
      messageId: 'sys-1',
    });

    const addMessageToChat = vi.fn();

    await replayConversationHistory({
      mlsService: mls,
      groupId: 'g-1',
      contactName: 'grp_1',
      userId: 'jolan',
      pin: '1234',
      addMessageToChat,
      getConversation: () => undefined,
      setConversation: vi.fn(),
      messageReactions: new Map(),
      log: vi.fn(),
    });

    expect(addMessageToChat).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('alice a ajouté bob, charlie au groupe'),
      'grp_1',
      undefined,
      true,
      'sys-1',
      expect.any(Date)
    );
    expect(mls.saveState).toHaveBeenCalled();
  });

  it('met a jour les reactions en remplacant la reaction precedente du meme utilisateur', async () => {
    const mls = makeMls({
      fetchHistory: vi
        .fn()
        .mockResolvedValue([{ sender_id: 'ALICE', content: btoa('x'), timestamp: Date.now() }]),
    });

    decodeAppMessageMock.mockReturnValue({
      reaction: {
        messageId: 'msg-1',
        emoji: '🔥',
      },
    });

    const reactions = new Map<string, Array<{ emoji: string; userId: string }>>([
      [
        'msg-1',
        [
          { emoji: '👍', userId: 'alice' },
          { emoji: '😀', userId: 'bob' },
        ],
      ],
    ]);

    await replayConversationHistory({
      mlsService: mls,
      groupId: 'g-1',
      contactName: 'grp_1',
      userId: 'jolan',
      pin: '1234',
      addMessageToChat: vi.fn(),
      getConversation: () => undefined,
      setConversation: vi.fn(),
      messageReactions: reactions,
      log: vi.fn(),
    });

    expect(reactions.get('msg-1')).toEqual([
      { emoji: '😀', userId: 'bob' },
      { emoji: '🔥', userId: 'alice' },
    ]);
  });

  it('applique read_receipt aux messages locaux pendant le replay', async () => {
    const convo: Conversation = {
      contactName: 'grp',
      name: 'grp',
      groupId: 'g-1',
      messages: [
        {
          id: 'm-1',
          senderId: 'jolan',
          content: 'hello',
          timestamp: new Date(),
          isOwn: true,
          readBy: [],
        },
      ],
      isReady: true,
      mlsStateHex: null,
      conversationType: 'group',
    };

    const mls = makeMls({
      fetchHistory: vi
        .fn()
        .mockResolvedValue([{ sender_id: 'Alice', content: btoa('x'), timestamp: Date.now() }]),
    });

    decodeAppMessageMock.mockReturnValue({
      system: {
        event: 'read_receipt',
        data: JSON.stringify({ messageIds: ['m-1'] }),
      },
    });

    const setConversation = vi.fn();

    await replayConversationHistory({
      mlsService: mls,
      groupId: 'g-1',
      contactName: 'grp_1',
      userId: 'jolan',
      pin: '1234',
      addMessageToChat: vi.fn(),
      getConversation: () => convo,
      setConversation,
      messageReactions: new Map(),
      log: vi.fn(),
    });

    expect(setConversation).toHaveBeenCalledWith(
      'grp_1',
      expect.objectContaining({
        messages: [expect.objectContaining({ id: 'm-1', readBy: ['alice'] })],
      })
    );
  });
});
