// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'me' }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));
vi.mock('$lib/utils/chat/historyDiffAnswer', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/chat/historyDiffAnswer')>()),
  answerHistoryDigest: vi.fn(async () => undefined),
}));

import { handleSystemEvent } from './systemMessageHandler';
import { historyGrantPayload, noteIssuedGrant } from '$lib/utils/chat/historyGrant';

/**
 * A member sends their history to a newcomer (owner, 2026-11-25): the grant frame every member
 * draws, and the granter's refusal of an ask it cannot vouch for.
 */
const GRANT = {
  grantId: 'grant-0001',
  newcomer: 'newbie',
  granter: 'ann:a1',
  since: 1_000,
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set('g1', {
    id: 'g1',
    conversationType: 'group',
    unreadCount: 0,
    readWatermarks: {},
    messages: [],
  });
  return {
    mlsService: {
      getDeviceId: () => 'device-me',
      sendMessage: vi.fn(),
    },
    deliveryMeta: { queuedCreatedAt: 1_000_000, senderDeviceId: 'a1' },
    storage: null,
    userId: 'me',
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new ReactionsByConversation(),
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
    sentAt: 999_000,
    messageId: 'notice-1',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());

describe('handleSystemEvent - historyGranted', () => {
  it('every member draws the notice; a member who is not the newcomer asks nothing', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('historyGranted', historyGrantPayload(GRANT), ctx as any);
    expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
    expect(ctx.addMessageToChat.mock.calls[0][2]).toBe('g1');
    expect(ctx.mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('a grant naming another member as the granter draws nothing', async () => {
    const ctx = makeCtx({ senderNorm: 'mallory' });
    await handleSystemEvent('historyGranted', historyGrantPayload(GRANT), ctx as any);
    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
  });

  it('a grant in a 1:1 or a salon is refused', async () => {
    const ctx = makeCtx();
    ctx.convo.conversationType = 'direct';
    await handleSystemEvent('historyGranted', historyGrantPayload(GRANT), ctx as any);
    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
  });
});

describe('handleSystemEvent - history_grant_ask', () => {
  const ask = (to: string, grantId = GRANT.grantId) => ({
    from: 'newbie:n1',
    to,
    grantId,
    digest: { mode: 'ids', ids: [] },
    since: 0,
    requestId: 'req-00000001',
    answerKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  });

  it('is answered by the granting device, only against a grant it issued to that person', async () => {
    const { answerHistoryDigest } = await import('$lib/utils/chat/historyDiffAnswer');
    const granter = { ...GRANT, granter: 'me:device-me' };
    noteIssuedGrant('me', 'g1', granter);
    const ctx = makeCtx({ senderNorm: 'newbie', deliveryMeta: { senderDeviceId: 'n1' } });
    await handleSystemEvent('history_grant_ask', ask('me:device-me'), ctx as any);
    // Nothing issued under this id: refused.
    await handleSystemEvent('history_grant_ask', ask('me:device-me', 'grant-9999'), ctx as any);
    // Addressed to another device: ignored.
    await handleSystemEvent('history_grant_ask', ask('me:other-device'), ctx as any);
    // An ask from someone the grant does not name: refused.
    const intruder = makeCtx({ senderNorm: 'mallory' });
    await handleSystemEvent(
      'history_grant_ask',
      { ...ask('me:device-me'), from: 'mallory:m1' },
      intruder as any
    );
    await vi.waitFor(() => expect(vi.mocked(answerHistoryDigest)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(answerHistoryDigest).mock.calls[0][0]).toMatchObject({
      requesterIdentity: 'newbie:n1',
      grantSince: granter.since,
      since: granter.since,
    });
  });
});
