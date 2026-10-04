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
  const storage = { updateMessage: vi.fn().mockResolvedValue(undefined) };
  return {
    mlsService: { getDeviceId: () => 'device-me' },
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

  it('never takes the body from a peer that is NOT the author - only the flag', async () => {
    const ctx = makeCtx('mallory', { ...HELD });

    await handleSystemEvent('history_bundle', { messages: [EDITED] }, ctx as any);

    const row = ctx.conversations.get(GROUP).messages[0];
    expect(row.content).toBe('before');
    expect(row.isEdited).toBe(true);
    expect(ctx.storage.updateMessage).toHaveBeenCalledWith(
      'm1',
      expect.not.objectContaining({ content: expect.anything() }),
      'device-key'
    );
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
