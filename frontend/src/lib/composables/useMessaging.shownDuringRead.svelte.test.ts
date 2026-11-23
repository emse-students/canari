// @vitest-environment happy-dom
/**
 * WHAT AN ARRIVING ADD DECIDED AT ENTRY IS DECIDED AGAIN WHEN ITS STORE READ CHANGED IT (review of
 * #3988).
 *
 * Both inbound paths read the conversation, then await the store (`getMessagesByIds`). Two facts read
 * at entry can be false after it:
 *
 * - THE ID IS NOW SHOWN by another writer - a notification preview, say. The add is not a new
 *   arrival any more: the preview takes the body (as at entry), and nothing is counted, rung or
 *   announced a second time.
 * - THE CONVERSATION LEFT THE MAP. Storing the row then resurrects a deleted conversation's rows;
 *   the message goes to the orphan buffer instead, as at entry.
 *
 * A real store (`fake-indexeddb`), so what is kept on disk is asserted, not a mock's call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import type { ChatMessage } from '$lib/types';
import {
  CONVO,
  KEY,
  deleteFrame,
  editFrame,
  makeDevice,
  reactionFrame,
  freshStoreName,
} from './pendingMutations.test-helper';

vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async () => 'Peer',
    resolveDisplayNames: async () => (id: string) => id,
  };
});
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobileTauriRuntime: () => false,
}));

const { useMessaging } = await import('./useMessaging.svelte');
const { purgeConversation } = await import('$lib/utils/chat/conversations');

const PEER = 'peer-user-id';
const BODY = '{"kind":"text","text":"the real body"}';

const preview = (id: string): ChatMessage => ({
  id,
  senderId: PEER,
  content: 'caption',
  timestamp: new Date(5_000),
  isOwn: false,
  isFcmPreview: true,
});

/**
 * A device whose first store read runs `during` before it answers - the other writer's gap. `before`
 * runs first, with the store not yet watched (a mutation frame reads the store too).
 */
async function deviceWithGap(
  during: (d: ReturnType<typeof makeDevice>) => void,
  before?: (d: ReturnType<typeof makeDevice>) => Promise<unknown>
) {
  const storage = new IndexedDbStorage(freshStoreName());
  await storage.init();
  const d = makeDevice(useMessaging, storage);
  await before?.(d);
  const read = storage.getMessagesByIds.bind(storage);
  const gap = vi.spyOn(storage, 'getMessagesByIds').mockImplementationOnce(async (...args) => {
    during(d);
    return read(...args);
  });
  return { d, gap, read };
}

/** The other writer shows a preview of `id` and counts it, as the push path does. */
const previewShown = (id: string) => (d: ReturnType<typeof makeDevice>) => {
  const current = d.conversations.get(CONVO)!;
  d.conversations.set(CONVO, { ...current, messages: [preview(id)], unreadCount: 1 });
};

const conversationRemoved = (d: ReturnType<typeof makeDevice>) => {
  d.conversations.delete(CONVO);
};

/** Lets the effects' own promises (the notification's sender lookup) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the id was shown by another writer during the store read', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts'); // nobody is reading: a NEW arrival would notify
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('THE SINGLE PATH: one message, counted once, upgraded, no second tone or notification', async () => {
    const { d, gap, read } = await deviceWithGap(previewShown('p1'));

    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, {
      messageId: 'p1',
      serverTimestamp: 5_000,
    });
    await settle();

    expect(gap).toHaveBeenCalled();
    const shown = d.shown();
    expect(shown.map((m) => m.id)).toEqual(['p1']);
    expect(shown[0].isFcmPreview).toBeFalsy();
    expect(shown[0].content).toContain('the real body');
    expect(d.conversations.get(CONVO)!.unreadCount).toBe(1);
    expect(d.ctx.playReceiveTone).not.toHaveBeenCalled();
    expect(d.ctx.playNotificationTone).not.toHaveBeenCalled();
    expect(d.ctx.sendSystemNotification).not.toHaveBeenCalled();
    const stored = await read(CONVO, ['p1'], KEY);
    expect(stored.rows.get('p1')?.content).toContain('the real body');
  });

  it('THE BATCH PATH: the same - one message, counted once, upgraded, nothing announced', async () => {
    const { d, gap, read } = await deviceWithGap(previewShown('p1'));

    await d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'p1', serverTimestamp: 5_000 }],
      CONVO,
      d.ctx,
      'arrival'
    );
    await settle();

    expect(gap).toHaveBeenCalled();
    const shown = d.shown();
    expect(shown.map((m) => m.id)).toEqual(['p1']);
    expect(shown[0].isFcmPreview).toBeFalsy();
    expect(shown[0].content).toContain('the real body');
    expect(d.conversations.get(CONVO)!.unreadCount).toBe(1);
    expect(d.ctx.playReceiveTone).not.toHaveBeenCalled();
    expect(d.ctx.sendSystemNotification).not.toHaveBeenCalled();
    const stored = await read(CONVO, ['p1'], KEY);
    expect(stored.rows.get('p1')?.content).toContain('the real body');
  });

  it('CONTROL: nothing shown in the gap - the arrival is counted and announced', async () => {
    const { d } = await deviceWithGap(() => {});

    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, {
      messageId: 'p1',
      serverTimestamp: 5_000,
    });

    await vi.waitFor(() => expect(d.ctx.sendSystemNotification).toHaveBeenCalledTimes(1));
    expect(d.conversations.get(CONVO)!.unreadCount).toBe(1);
  });
});

describe('the conversation left the map during the store read', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('THE SINGLE PATH: nothing stored into it, nothing announced, the conversation stays gone', async () => {
    const { d, read } = await deviceWithGap(conversationRemoved);

    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, {
      messageId: 'm1',
      serverTimestamp: 5_000,
    });
    await settle();

    expect(d.conversations.has(CONVO)).toBe(false);
    expect((await read(CONVO, ['m1'], KEY)).rows.has('m1')).toBe(false);
    expect(d.ctx.sendSystemNotification).not.toHaveBeenCalled();
  });

  it('THE BATCH PATH: the same', async () => {
    const { d, read } = await deviceWithGap(conversationRemoved);

    await d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'm1', serverTimestamp: 5_000 }],
      CONVO,
      d.ctx,
      'arrival'
    );
    await settle();

    expect(d.conversations.has(CONVO)).toBe(false);
    expect((await read(CONVO, ['m1'], KEY)).rows.has('m1')).toBe(false);
    expect(d.ctx.sendSystemNotification).not.toHaveBeenCalled();
  });
});

describe('a late-held preview takes the body WITH what waited for it (re-review of #3988)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('THE BATCH PATH, a deletion before the body: the preview shows the tombstone, as stored', async () => {
    const { d } = await deviceWithGap(previewShown('p1'), (dev) => deleteFrame(dev, PEER, 'p1'));

    await d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'p1', serverTimestamp: 5_000 }],
      CONVO,
      d.ctx,
      'arrival'
    );

    const [shown] = d.shown();
    expect(shown.id).toBe('p1');
    expect(shown.isDeleted).toBe(true);
    expect(shown.content).not.toContain('the real body');
    expect((await d.storage.getMessage('p1', KEY))?.isDeleted).toBe(true);
  });

  it('THE BATCH PATH, an edit before the body: the preview shows the edit, as stored', async () => {
    const { d, read } = await deviceWithGap(previewShown('p1'), (dev) =>
      editFrame(dev, PEER, 'p1', 'the real edit', 6_000)
    );

    await d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'p1', serverTimestamp: 5_000 }],
      CONVO,
      d.ctx,
      'arrival'
    );

    const [shown] = d.shown();
    expect(shown.isEdited).toBe(true);
    expect(shown.content).toContain('the real edit');
    expect((await read(CONVO, ['p1'], KEY)).rows.get('p1')?.content).toContain('the real edit');
  });
});

describe('an upgrade never inserts into a conversation removed during its await (re-review of #3988)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const storedPreview = {
    id: 'p1',
    conversationId: CONVO,
    senderId: PEER,
    content: 'caption',
    timestamp: 5_000,
    isFcmPreview: true,
  };

  /** A device whose first pending-mutation read removes the conversation, rows and all. */
  async function removedOnPendingRead() {
    const storage = new IndexedDbStorage(freshStoreName());
    await storage.init();
    const d = makeDevice(useMessaging, storage);
    await storage.saveMessage(storedPreview, KEY);
    const pendingRead = storage.getPendingMutations.bind(storage);
    vi.spyOn(storage, 'getPendingMutations').mockImplementationOnce(async (...args) => {
      d.conversations.delete(CONVO);
      await storage.deleteMessagesForConversation(CONVO);
      return pendingRead(...args);
    });
    return d;
  }

  it('THE STORED PREVIEW (settleStoredBodies): the body is not inserted, a WARN says so', async () => {
    const d = await removedOnPendingRead();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'p1', serverTimestamp: 5_000 }],
      CONVO,
      d.ctx,
      'arrival'
    );

    expect((await d.storage.getMessagesByIds(CONVO, ['p1'], KEY)).rows.has('p1')).toBe(false);
    expect(warn.mock.calls.some(([line]) => String(line).includes('not inserted'))).toBe(true);
  });

  it('THE SHOWN PREVIEW (the live upgrade): the body is not inserted, a WARN says so', async () => {
    const d = await removedOnPendingRead();
    d.conversations.set(CONVO, {
      ...d.conversations.get(CONVO)!,
      messages: [preview('p1')],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, {
      messageId: 'p1',
      serverTimestamp: 5_000,
    });

    expect(d.conversations.has(CONVO)).toBe(false);
    expect((await d.storage.getMessagesByIds(CONVO, ['p1'], KEY)).rows.has('p1')).toBe(false);
    expect(warn.mock.calls.some(([line]) => String(line).includes('not inserted'))).toBe(true);
  });
});

describe('the last gaps (final check of #3988)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it("THE REACTIONS MAP: a late-held preview's reaction and a pending one both reach the bubble", async () => {
    const onPreview = { emoji: 'heart', userId: 'someone', at: 4_000 };
    const { d } = await deviceWithGap(
      (dev) => {
        const current = dev.conversations.get(CONVO)!;
        dev.conversations.set(CONVO, {
          ...current,
          messages: [{ ...preview('p1'), reactions: [onPreview] }],
          unreadCount: 1,
        });
      },
      (dev) => reactionFrame(dev, 'another', 'p1', 'plus-one', 4_500)
    );

    await d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'p1', serverTimestamp: 5_000 }],
      CONVO,
      d.ctx,
      'arrival'
    );

    // What the bubble reads: the map first, the row's own reactions otherwise.
    const [shown] = d.shown();
    const bubble = d.messaging.messageReactions.get('p1') ?? shown.reactions ?? [];
    expect(bubble.map((r) => r.emoji).sort()).toEqual(['heart', 'plus-one']);
  });

  it('A KEPT WRITE RETRIED AFTER ITS CONVERSATION LEFT: nothing inserted, the hold is released', async () => {
    const { d } = await deviceWithGap(previewShown('p1'));
    // The batch's write fails transiently: kept for the next checkpoint's hold.
    vi.spyOn(d.storage, 'saveMessagesIfAbsent').mockRejectedValueOnce(
      new DOMException('full', 'QuotaExceededError')
    );
    await d.messaging.batchAddMessages(
      [
        { senderId: PEER, content: BODY, messageId: 'p1', serverTimestamp: 5_000 },
        { senderId: PEER, content: BODY, messageId: 'm2', serverTimestamp: 6_000 },
      ],
      CONVO,
      d.ctx,
      'arrival'
    );
    expect(
      d
        .shown()
        .map((m) => m.id)
        .sort()
    ).toEqual(['m2', 'p1']);
    // The conversation is removed while the retry's merge waits.
    const merge = d.storage.mergeMessages.bind(d.storage);
    vi.spyOn(d.storage, 'mergeMessages').mockImplementationOnce(async (...args) => {
      d.conversations.delete(CONVO);
      await d.storage.deleteMessagesForConversation(CONVO);
      return merge(...args);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const release = await d.messaging.holdRowsForCheckpoint(d.ctx);
    release();

    expect(d.conversations.has(CONVO)).toBe(false);
    expect(await d.storage.getMessage('p1', KEY)).toBeFalsy();
    expect(await d.storage.getMessage('m2', KEY)).toBeFalsy();
    expect(warn.mock.calls.some(([line]) => String(line).includes('not inserted'))).toBe(true);
  });
});

describe('a removal racing a batch write that already asked the map (follow-up of #3988)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('the purge takes the map first, waits for the insert, then clears the store - nothing comes back', async () => {
    const storage = new IndexedDbStorage(freshStoreName());
    await storage.init();
    const d = makeDevice(useMessaging, storage);
    // The insert is held open AFTER the map said the conversation stands.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const insert = storage.saveMessagesIfAbsent.bind(storage);
    const held = vi.spyOn(storage, 'saveMessagesIfAbsent').mockImplementation(async (rows, key) => {
      if (rows.length > 0) await gate;
      return insert(rows, key);
    });

    const adding = d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'm1', serverTimestamp: 5_000 }],
      CONVO,
      d.ctx,
      'arrival'
    );
    await vi.waitFor(() => expect(held).toHaveBeenCalled());

    let purged = false;
    const purging = purgeConversation({
      conversations: d.conversations,
      key: CONVO,
      deleteStored: (key) => storage.deleteConversation(key),
    }).then(() => (purged = true));
    // Out of the map at once; the store is not cleared while the insert it must take is in flight.
    expect(d.conversations.has(CONVO)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(purged).toBe(false);

    release();
    await adding;
    await purging;

    expect(await storage.getMessage('m1', KEY)).toBeFalsy();
  });
});
