// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'me' }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { handleSystemEvent } from './systemMessageHandler';
import {
  nicknameEntry,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';

/**
 * "MODIFIER LES PSEUDOS" ON THE LIVE PATH: the silent `nickname` frame, and the register a
 * `history_bundle` restates for a member admitted after the frame went out.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set('g1', { id: 'g1', unreadCount: 0, readWatermarks: {}, messages: [] });
  return {
    mlsService: { getDeviceId: () => 'device-me' },
    storage: null,
    userId: 'me',
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get('g1'),
    convoKey: 'g1',
    senderNorm: 'ann',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetConversationNicknamesForTests();
});

describe('handleSystemEvent - nickname', () => {
  it('applies the frame with the MLS sender as setter, and adds no message to the thread', async () => {
    const ctx = makeCtx();
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'Capitaine', at: 10, setBy: 'forged' },
      ctx as any
    );
    expect(nicknameEntry('g1', 'bob')).toEqual({ nickname: 'Capitaine', setBy: 'ann', at: 10 });
    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
  });

  it('applies a reset', async () => {
    const ctx = makeCtx();
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'Capitaine', at: 10 },
      ctx as any
    );
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: null, at: 11 },
      makeCtx({ senderNorm: 'bob' }) as any
    );
    expect(nicknameEntry('g1', 'bob')).toEqual({ nickname: null, setBy: 'bob', at: 11 });
  });
});

describe('handleSystemEvent - history_bundle restates the nicknames', () => {
  it('a bundle carrying no messages at all still hands a late joiner the register', async () => {
    const ctx = makeCtx({ senderNorm: 'inviter' });
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        nicknames: [{ userId: 'bob', nickname: 'Capitaine', setBy: 'ann', at: 10 }],
      },
      ctx as any
    );
    expect(nicknameEntry('g1', 'bob')).toEqual({ nickname: 'Capitaine', setBy: 'ann', at: 10 });
  });

  it('does not let a bundle overrule a newer frame already applied', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('nickname', { userId: 'bob', nickname: 'New', at: 20 }, ctx as any);
    await handleSystemEvent(
      'history_bundle',
      { messages: [], nicknames: [{ userId: 'bob', nickname: 'Old', setBy: 'cy', at: 10 }] },
      makeCtx({ senderNorm: 'cy' }) as any
    );
    expect(nicknameEntry('g1', 'bob')?.nickname).toBe('New');
  });
});
