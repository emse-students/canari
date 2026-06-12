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
