import { handleSystemEvent } from './systemMessageHandler';

/**
 * Only a message's author may edit or delete it, and the rule is enforced HERE - on receipt - because
 * the control that offers the action runs on the sender's device, which is the attacker's side of the
 * wire. The sender identity used is the one MLS authenticated for the frame.
 */

/** Builds a minimal context holding one message authored by `owner`. */
function makeCtx(senderNorm: string, owner = 'peer') {
  const conversations = new Map<string, any>();
  conversations.set('g1', {
    id: 'g1',
    unreadCount: 0,
    messages: [{ id: 'm1', senderId: owner, content: 'original', readBy: [] }],
  });
  const storage = { saveMessage: vi.fn().mockResolvedValue(undefined) };
  return {
    mlsService: {},
    storage,
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
    senderNorm,
    persistMlsStateNow: vi.fn(),
  };
}

/** The single message currently held for the conversation. */
const msgOf = (ctx: ReturnType<typeof makeCtx>) => (ctx.conversations.get('g1') as any).messages[0];

describe('handleSystemEvent - delete_message ownership', () => {
  it('applies a delete sent by the author', async () => {
    const ctx = makeCtx('peer');
    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(msgOf(ctx).isDeleted).toBe(true);
  });

  it('REFUSES a delete of a message the sender does not own, and says so in the log', async () => {
    const ctx = makeCtx('attacker');
    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(msgOf(ctx).isDeleted).toBeUndefined();
    expect(msgOf(ctx).content).toBe('original');
    expect(ctx.storage.saveMessage).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Refused a delete'));
  });

  it('REFUSES a delete when the target carries no author at all', async () => {
    const ctx = makeCtx('attacker', '');
    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(msgOf(ctx).isDeleted).toBeUndefined();
  });

  it('matches the author case-insensitively, as ids are normalised on only one side', async () => {
    const ctx = makeCtx('PEER');
    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(msgOf(ctx).isDeleted).toBe(true);
  });
});

describe('handleSystemEvent - edit_message ownership', () => {
  it('applies an edit sent by the author', async () => {
    const ctx = makeCtx('peer');
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'rewritten' },
      ctx as any
    );

    expect(msgOf(ctx).content).toBe('rewritten');
    expect(msgOf(ctx).isEdited).toBe(true);
  });

  it('REFUSES an edit of a message the sender does not own, and says so in the log', async () => {
    const ctx = makeCtx('attacker');
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'rewritten' },
      ctx as any
    );

    expect(msgOf(ctx).content).toBe('original');
    expect(msgOf(ctx).isEdited).toBeUndefined();
    expect(ctx.storage.saveMessage).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Refused an edit'));
  });
});
