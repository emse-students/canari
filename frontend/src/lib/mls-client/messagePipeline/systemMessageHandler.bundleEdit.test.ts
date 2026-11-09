import { handleSystemEvent } from './systemMessageHandler';

/**
 * A `history_bundle` over a message this device ALREADY holds, carrying an edit it missed.
 *
 * The body is taken ONLY when the peer that answered is the message's author - the same rule the
 * live `edit_message` path enforces - and only when it supersedes what the row holds. Any other
 * member's bundle may set the "edited" flag but never put words in the author's mouth.
 */
const GROUP = 'g1';
const AUTHOR = 'alice';

function makeCtx(senderNorm: string, held: Record<string, unknown>) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [held] });
  const storage = {
    updateMessage: vi.fn().mockResolvedValue(undefined),
    // Every rewrite of a stored row is a compare-and-set now: this one merges onto a bare row and
    // hands the result to `updateMessage`, which the assertions below read.
    async mergeMessages(c: string, ids: string[], merge: (row: any) => any, key: string) {
      for (const id of ids) {
        const next = merge({ id, conversationId: c, senderId: '', content: '', timestamp: 0 });
        if (next) await this.updateMessage(id, next, key);
      }
      return new Set(ids);
    },
    getPendingMutations: vi.fn(async () => ({ entries: [], removedUnreadable: 0 })),
  };
  return {
    mlsService: { getDeviceId: () => 'device-me' },
    storage,
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
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm,
    persistMlsStateNow: vi.fn(),
  };
}

const HELD = { id: 'm1', senderId: AUTHOR, content: 'before', timestamp: new Date(1000) };
const EDITED = {
  id: 'm1',
  senderId: AUTHOR,
  content: 'after',
  timestamp: 1000,
  isEdited: true,
  editedAt: 5000,
};

describe('history_bundle - an edit the device missed', () => {
  it('takes the edited body when the AUTHOR answered, and writes it at rest', async () => {
    const ctx = makeCtx(AUTHOR, { ...HELD });

    await handleSystemEvent('history_bundle', { messages: [EDITED] }, ctx as any);

    const row = ctx.conversations.get(GROUP).messages[0];
    expect(row.content).toBe('after');
    expect(row.isEdited).toBe(true);
    expect(row.editedAt).toEqual(new Date(5000));
    expect(ctx.storage.updateMessage).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ content: 'after', isEdited: true, editedAt: 5000 }),
      'device-key'
    );
  });

  it('takes nothing of an edit from a peer that is NOT the author - not the body, not the flag', async () => {
    // The flag and the time are the edit's as much as the body is: a third party's word that a
    // message was edited is no more evidence than its word for the text (bundleVetting.ts).
    const ctx = makeCtx('mallory', { ...HELD });

    await handleSystemEvent('history_bundle', { messages: [EDITED] }, ctx as any);

    const row = ctx.conversations.get(GROUP).messages[0];
    expect(row.content).toBe('before');
    expect(row.isEdited).toBeFalsy();
    expect(ctx.storage.updateMessage).not.toHaveBeenCalled();
  });

  it("keeps a LATER edit the row already holds, even from the author's bundle", async () => {
    const ctx = makeCtx(AUTHOR, {
      ...HELD,
      content: 'newest',
      isEdited: true,
      editedAt: new Date(9000),
    });

    await handleSystemEvent('history_bundle', { messages: [EDITED] }, ctx as any);

    expect(ctx.conversations.get(GROUP).messages[0].content).toBe('newest');
  });

  it('never resurrects a body over a tombstone', async () => {
    const ctx = makeCtx(AUTHOR, { ...HELD, content: 'deleted', isDeleted: true });

    await handleSystemEvent('history_bundle', { messages: [EDITED] }, ctx as any);

    expect(ctx.conversations.get(GROUP).messages[0].content).toBe('deleted');
  });
});
