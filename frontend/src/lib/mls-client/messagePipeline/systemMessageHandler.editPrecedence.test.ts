import { handleSystemEvent } from './systemMessageHandler';

/**
 * An edit is applied only if it is newer than the one the row already carries.
 *
 * WHAT THIS PINS, and it is not the ordering itself - `editPrecedence.test.ts` owns that. It is that
 * the LIVE path consults the rule at all. It did not: `edit_message` was applied on arrival, so the
 * surviving body was "whichever frame came last", which is a different answer on every device. MUT-18
 * crossed two edits of one message from two devices of one account and ended with W1 showing A1's
 * text, A1 showing W1's, and neither ever moving again - silent, permanent, no error anywhere.
 */

/** A context holding one message authored by `owner`, optionally already edited at `editedAt`. */
function makeCtx(senderNorm: string, editedAt?: number) {
  const conversations = new Map<string, any>();
  conversations.set('g1', {
    id: 'g1',
    unreadCount: 0,
    messages: [
      {
        id: 'm1',
        senderId: 'peer',
        content: editedAt === undefined ? 'original' : 'held-edit',
        readBy: [],
        ...(editedAt === undefined ? {} : { isEdited: true, editedAt: new Date(editedAt) }),
      },
    ],
  });
  return {
    mlsService: {},
    storage: { updateMessage: vi.fn().mockResolvedValue(undefined) },
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
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: {},
    convoKey: 'g1',
    senderNorm,
    persistMlsStateNow: vi.fn(),
  };
}

const msgOf = (ctx: ReturnType<typeof makeCtx>) => (ctx.conversations.get('g1') as any).messages[0];

describe('handleSystemEvent - edit_message precedence', () => {
  it('applies an edit to a row that carries none', async () => {
    const ctx = makeCtx('peer');
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'first', editedAt: 1000 },
      ctx as any
    );

    expect(msgOf(ctx).content).toBe('first');
    expect(ctx.storage.updateMessage).toHaveBeenCalled();
  });

  it('applies an edit NEWER than the one held', async () => {
    const ctx = makeCtx('peer', 1000);
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'newer', editedAt: 2000 },
      ctx as any
    );

    expect(msgOf(ctx).content).toBe('newer');
  });

  it('DROPS an edit older than the one held, and says so in the log', async () => {
    const ctx = makeCtx('peer', 2000);
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'stale', editedAt: 1000 },
      ctx as any
    );

    expect(msgOf(ctx).content).toBe('held-edit');
    expect(ctx.storage.updateMessage).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Dropped an edit'));
  });

  it('does not write storage when re-applying the identical edit', async () => {
    const ctx = makeCtx('peer', 1000);
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'held-edit', editedAt: 1000 },
      ctx as any
    );

    expect(msgOf(ctx).content).toBe('held-edit');
    expect(ctx.storage.updateMessage).not.toHaveBeenCalled();
  });

  it('CONVERGES: two devices given the same pair in opposite orders end on the same body', async () => {
    const w1 = { messageId: 'm1', newContent: 'from-W1', editedAt: 1000 };
    const a1 = { messageId: 'm1', newContent: 'from-A1', editedAt: 2000 };

    // The device that edited as W1 then receives A1's frame.
    const asW1 = makeCtx('peer');
    await handleSystemEvent('edit_message', w1, asW1 as any);
    await handleSystemEvent('edit_message', a1, asW1 as any);

    // The device that edited as A1 then receives W1's frame.
    const asA1 = makeCtx('peer');
    await handleSystemEvent('edit_message', a1, asA1 as any);
    await handleSystemEvent('edit_message', w1, asA1 as any);

    expect(msgOf(asW1).content).toBe(msgOf(asA1).content);
    expect(msgOf(asW1).content).toBe('from-A1');
  });

  it('DROPS an edit of a deleted message - a tombstone is final, whatever the order', async () => {
    const ctx = makeCtx('peer');
    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);
    const tombstone = msgOf(ctx).content;
    ctx.storage.updateMessage.mockClear();

    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'resurrected', editedAt: 9999 },
      ctx as any
    );

    // The tombstone is carried in `content`, so applying the edit would put the deleted text back
    // on screen - the one outcome a delete exists to prevent.
    expect(msgOf(ctx).content).toBe(tombstone);
    expect(msgOf(ctx).isDeleted).toBe(true);
    expect(ctx.storage.updateMessage).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('a tombstone is final'));
  });

  it('CONVERGES on the tombstone whichever of delete and edit arrives first', async () => {
    const edit = { messageId: 'm1', newContent: 'edited', editedAt: 5000 };

    const editFirst = makeCtx('peer');
    await handleSystemEvent('edit_message', edit, editFirst as any);
    await handleSystemEvent('delete_message', { messageId: 'm1' }, editFirst as any);

    const deleteFirst = makeCtx('peer');
    await handleSystemEvent('delete_message', { messageId: 'm1' }, deleteFirst as any);
    await handleSystemEvent('edit_message', edit, deleteFirst as any);

    expect(msgOf(editFirst).content).toBe(msgOf(deleteFirst).content);
    expect(msgOf(editFirst).isDeleted).toBe(true);
    expect(msgOf(deleteFirst).isDeleted).toBe(true);
  });

  it('still refuses an edit from a sender who does not own the message, whatever its date', async () => {
    const ctx = makeCtx('attacker', 1000);
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'hijack', editedAt: 9999 },
      ctx as any
    );

    expect(msgOf(ctx).content).toBe('held-edit');
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Refused an edit'));
  });
});
