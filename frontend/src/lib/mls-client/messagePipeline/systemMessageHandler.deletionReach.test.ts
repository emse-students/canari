import { handleSystemEvent } from './systemMessageHandler';
import { m } from '$lib/paraglide/messages';

/**
 * A deletion reaches its target wherever the target is - shown, stored but not shown, or not here
 * yet (owner's report, 2026-11-02: a message the other person deleted was still shown on a device
 * signed in after the deletion).
 *
 * Memory holds a window: the boot restore seeds every conversation with `messages: []` and a drain
 * handles a `delete_message` against that. The handler used to look in memory alone, so a deletion
 * of a stored row was acknowledged and forgotten - and its frame, consumed, never replays.
 */

const PEER = 'peer';

/** A conversation as the boot restore seeds it - no message shown - over a store holding `rows`. */
function makeCtx(rows: Record<string, any>, senderNorm = PEER) {
  const conversations = new Map<string, any>();
  conversations.set('g1', { id: 'g1', unreadCount: 0, messages: [] });
  const store = new Map<string, any>(Object.entries(rows));
  const storage = {
    getMessagesByIds: vi.fn(async (ids: string[]) => ({
      rows: new Map(ids.filter((id) => store.has(id)).map((id) => [id, store.get(id)])),
      unreadable: new Set<string>(),
    })),
    updateMessage: vi.fn(async (id: string, patch: any) => {
      const row = store.get(id);
      if (row) store.set(id, { ...row, ...patch });
    }),
    saveMessageIfAbsent: vi.fn(async (msg: any) => {
      if (store.has(msg.id)) return false;
      store.set(msg.id, msg);
      return true;
    }),
  };
  const ctx = {
    mlsService: {},
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
    convo: {},
    convoKey: 'g1',
    senderNorm,
    persistMlsStateNow: vi.fn(),
    deliveryMeta: { queuedCreatedAt: 5_000 },
  };
  return { ctx, store, storage, conversations };
}

const stored = (senderId = PEER) => ({
  id: 'm1',
  conversationId: 'g1',
  senderId,
  content: 'original',
  timestamp: 1_000,
  authorship: { body: 'b', proof: 'p', group: 'g1' },
});

describe('handleSystemEvent - a delete_message whose target is stored but not shown', () => {
  it('tombstones the STORED row, so the next load shows the deletion', async () => {
    const { ctx, store } = makeCtx({ m1: stored() });

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(store.get('m1').isDeleted).toBe(true);
    expect(store.get('m1').content).toBe(m.chat_system_message_deleted());
    // The original signed bytes go with the body.
    expect(store.get('m1').authorship).toBeNull();
  });

  it('REFUSES it when the stored row is not the sender’s, exactly as for a shown one', async () => {
    const { ctx, store, storage } = makeCtx({ m1: stored('someone-else') });

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(store.get('m1').isDeleted).toBeUndefined();
    expect(storage.updateMessage).not.toHaveBeenCalled();
    expect(storage.saveMessageIfAbsent).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Refused a delete'));
  });
});

describe('handleSystemEvent - a delete_message that arrives before its target', () => {
  it('KEEPS the deletion as a tombstone under the target id, stored and shown', async () => {
    const { ctx, store, conversations } = makeCtx({});

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    const row = store.get('m1');
    expect(row).toMatchObject({
      id: 'm1',
      conversationId: 'g1',
      senderId: PEER,
      isDeleted: true,
      deletedBeforeArrival: true,
      content: m.chat_system_message_deleted(),
      serverTimestamp: 5_000,
    });
    const shown = conversations.get('g1').messages;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: 'm1', isDeleted: true, deletedBeforeArrival: true });
  });

  it('never writes over a row it could not read - the insert is the store’s to refuse', async () => {
    const { ctx, storage, conversations } = makeCtx({});
    // A row that `getMessage` cannot decrypt reads back as null, like an absent one.
    storage.saveMessageIfAbsent.mockResolvedValueOnce(false);

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(conversations.get('g1').messages).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('left as it is'));
  });
});

describe('handleSystemEvent - the conversation row comes before the tombstone that names it', () => {
  it('saves the conversation first, so a store with a foreign key has a row to name', async () => {
    // On SQLite a message row names its conversation; a group joined during the very drain that
    // carries the deletion may not have reached the store yet.
    const { ctx, storage } = makeCtx({});

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(ctx.saveConversation).toHaveBeenCalledWith('g1');
    expect(ctx.saveConversation.mock.invocationCallOrder[0]).toBeLessThan(
      storage.saveMessageIfAbsent.mock.invocationCallOrder[0]
    );
  });

  it('leaves a row this device cannot open alone, even absent from memory', async () => {
    const { ctx, storage } = makeCtx({});
    storage.getMessagesByIds.mockResolvedValueOnce({
      rows: new Map(),
      unreadable: new Set(['m1']),
    } as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(storage.saveMessageIfAbsent).not.toHaveBeenCalled();
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });
});
