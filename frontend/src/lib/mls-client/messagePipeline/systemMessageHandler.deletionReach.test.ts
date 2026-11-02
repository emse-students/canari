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
    saveMessagesIfAbsent: vi.fn(),
    putPendingMutation: vi.fn(async () => ({ written: true, evicted: 0 })),
    getPendingMutations: vi.fn(async () => ({ entries: [], unreadable: 0 })),
    deletePendingMutations: vi.fn(),
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
    expect(storage.putPendingMutation).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Refused a delete'));
  });
});

describe('handleSystemEvent - a delete_message that arrives before its target', () => {
  it('KEEPS it as a pending mutation - never a message row, never shown', async () => {
    const { ctx, store, storage, conversations } = makeCtx({});

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(storage.putPendingMutation).toHaveBeenCalledWith(
      {
        conversationId: 'g1',
        messageId: 'm1',
        sender: PEER,
        kind: 'delete',
        slot: '',
        rank: 0,
        at: 5_000,
      },
      expect.any(Number),
      'device-key'
    );
    expect(store.size).toBe(0);
    expect(storage.saveMessagesIfAbsent).not.toHaveBeenCalled();
    expect(conversations.get('g1').messages).toHaveLength(0);
  });

  it('keeps nothing from a frame with no server time, and says so at error', async () => {
    const { ctx, storage } = makeCtx({});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleSystemEvent('delete_message', { messageId: 'm1' }, {
      ...ctx,
      deliveryMeta: {},
    } as any);

    expect(storage.putPendingMutation).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no server time'));
  });

  it('leaves a row this device cannot open alone, even absent from memory', async () => {
    const { ctx, storage } = makeCtx({});
    storage.getMessagesByIds.mockResolvedValueOnce({
      rows: new Map(),
      unreadable: new Set(['m1']),
    } as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(storage.putPendingMutation).not.toHaveBeenCalled();
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });
});
