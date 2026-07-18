import { describe, it, expect, vi } from 'vitest';
import { handleSystemEvent } from './systemMessageHandler';

/** Construit un contexte minimal pour exercer le chemin read_receipt. */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set('g1', {
    id: 'g1',
    unreadCount: 3,
    messages: [{ id: 'm1', senderId: 'peer', readBy: [] }],
  });
  return {
    mlsService: {},
    storage: null,
    userId: 'me',
    pin: 'pin',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadReceiptReceived: vi.fn(),
    log: vi.fn(),
    convo: {},
    convoKey: 'g1',
    senderNorm: 'me',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

describe('handleSystemEvent - read_receipt cross-device', () => {
  it('receipt de mon propre user → remet unreadCount à 0 et persiste', async () => {
    const ctx = makeCtx({ senderNorm: 'me', userId: 'me' });
    await handleSystemEvent('read_receipt', { messageIds: ['m1'] }, ctx as any);

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(0);
    expect(ctx.saveConversation).toHaveBeenCalledWith('g1');
    // Le message est aussi marqué lu par moi.
    expect((ctx.conversations.get('g1') as any).messages[0].readBy).toContain('me');
  });

  it("receipt d'un pair → unreadCount inchangé, readBy mis à jour", async () => {
    const ctx = makeCtx({ senderNorm: 'peer', userId: 'me' });
    await handleSystemEvent('read_receipt', { messageIds: ['m1'] }, ctx as any);

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(3);
    expect(ctx.saveConversation).not.toHaveBeenCalled();
    expect((ctx.conversations.get('g1') as any).messages[0].readBy).toContain('peer');
    expect(ctx.onReadReceiptReceived).toHaveBeenCalled();
  });
});

describe('handleSystemEvent - history_bundle metadata merge', () => {
  it('merges bundle readBy/readAt onto an ALREADY-present message (own message read while stuck)', async () => {
    const conversations = new Map<string, any>();
    conversations.set('g1', {
      id: 'g1',
      unreadCount: 0,
      messages: [{ id: 'm1', senderId: 'me', content: 'hi', readBy: [] }],
    });
    const ctx = makeCtx({ conversations, convo: conversations.get('g1'), userId: 'me' });

    await handleSystemEvent(
      'history_bundle',
      {
        // Same id as the message we already have: the old code skipped it as a duplicate and
        // dropped its read state. readBy is upper-cased to assert normalisation.
        messages: [
          { id: 'm1', senderId: 'me', content: 'hi', timestamp: 1000, readBy: ['PEER'], readAt: 5 },
        ],
      },
      ctx as any
    );

    const msg = (ctx.conversations.get('g1') as any).messages[0];
    expect(msg.readBy).toContain('peer');
    expect(msg.readAt).toBe(5);
  });
});
