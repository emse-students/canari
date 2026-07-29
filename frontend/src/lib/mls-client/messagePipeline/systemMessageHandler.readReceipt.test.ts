import { handleSystemEvent } from './systemMessageHandler';

/** Builds a minimal context to exercise the read_receipt path. */
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
    deviceKeyB64: 'device-key',
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
    // The message is also marked read by me.
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

/**
 * The add-path that ingests a bundle cannot see readBy, so it badges the whole history as
 * unread; the receipts only land in the merge that follows. Each context below is seeded in
 * its post-add-path state (messages present, badge already counted) to exercise the recount.
 */
describe('handleSystemEvent - history_bundle unread recount', () => {
  function seed(unreadCount: number, messages: Array<Record<string, unknown>>) {
    const conversations = new Map<string, any>();
    conversations.set('g1', { id: 'g1', unreadCount, messages });
    return makeCtx({ conversations, convo: conversations.get('g1'), userId: 'me' });
  }

  const peerMsg = (id: string) => ({ id, senderId: 'peer', content: id, isOwn: false, readBy: [] });

  it('clears the badge for messages this user already read on another device', async () => {
    const ctx = seed(3, [peerMsg('m1'), peerMsg('m2'), peerMsg('m3')]);

    await handleSystemEvent(
      'history_bundle',
      {
        // Our own id comes back in readBy: the peer persisted our receipt and returns it here.
        // Mixed case asserts the normalisation on the way in.
        messages: [
          { id: 'm1', senderId: 'peer', content: 'm1', timestamp: 1, readBy: ['me'] },
          { id: 'm2', senderId: 'peer', content: 'm2', timestamp: 2, readBy: ['ME'] },
          { id: 'm3', senderId: 'peer', content: 'm3', timestamp: 3 },
        ],
      },
      ctx as any
    );

    // Only m3 was never acknowledged.
    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(1);
  });

  it('keeps the full count for a genuine new member, whose id is in no readBy', async () => {
    const ctx = seed(2, [peerMsg('m1'), peerMsg('m2')]);

    await handleSystemEvent(
      'history_bundle',
      {
        // Somebody else read them; this device never did.
        messages: [
          { id: 'm1', senderId: 'peer', content: 'm1', timestamp: 1, readBy: ['other'] },
          { id: 'm2', senderId: 'peer', content: 'm2', timestamp: 2, readBy: ['other'] },
        ],
      },
      ctx as any
    );

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(2);
  });

  it('never raises the badge of a conversation the add-path already zeroed', async () => {
    // unreadCount 0 = the conversation was open while the bundle landed.
    const ctx = seed(0, [peerMsg('m1'), peerMsg('m2')]);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          { id: 'm1', senderId: 'peer', content: 'm1', timestamp: 1 },
          { id: 'm2', senderId: 'peer', content: 'm2', timestamp: 2 },
        ],
      },
      ctx as any
    );

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(0);
  });
});
