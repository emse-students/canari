/**
 * A MESSAGE AND ITS MUTATIONS IN ONE CATCH-UP DRAIN (owner's report, 2026-11-02), against a REAL
 * local store.
 *
 * A device away while the other person sent a message and deleted it receives both in one drain
 * when it comes back - or signs in again. The drain buffers inbound bodies until it ends, and
 * handles the `delete_message` the moment it is decrypted: at that instant the body is in neither
 * memory nor the store. The deletion is KEPT as a pending mutation - never a message row - and
 * settled against the body's AUTHOR when the body is written (`pendingMutations.ts`).
 *
 * Each `it` names the review finding of #2936 it closes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { handleSystemEvent } from '$lib/mls-client/messagePipeline/systemMessageHandler';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import {
  CONVO,
  DRAIN,
  KEY,
  bodyFrame,
  deleteFrame,
  editFrame,
  makeDevice,
  freshStoreName,
  reactionFrame,
  systemContext,
} from './pendingMutations.test-helper';

/** Same notification-name stub as `useMessaging.bulkIngest.svelte.test.ts`. */
vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async (
      senderId: string,
      conversationKey: string,
      convo: Parameters<typeof real.notificationSenderName>[2]
    ) => real.notificationSenderName(senderId, conversationKey, convo),
    resolveDisplayNames: async () => (id: string) => id,
  };
});

/** Same import-cycle break as `useMessaging.bulkIngest.svelte.test.ts`. */
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const { useMessaging } = await import('./useMessaging.svelte');

/** Opens a fresh store - or, given its name, the same one again (a restart). */
async function openStore(name = freshStoreName()) {
  const storage = new IndexedDbStorage(name);
  await storage.init();
  return { storage, name };
}

const PEER = 'peer-user-id';
const OTHER = 'other-member-id';

async function device() {
  const { storage, name } = await openStore();
  return { ...makeDevice(useMessaging, storage), name };
}

const pending = (storage: IndexedDbStorage, ids = ['m1']) =>
  storage.getPendingMutations(CONVO, ids, KEY);

describe('a message and its mutations delivered in one drain', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it("shows and stores the TOMBSTONE, at the message's place - never the deleted text", async () => {
    const d = await device();
    const writes = [
      vi.spyOn(d.storage, 'saveMessage'),
      vi.spyOn(d.storage, 'saveMessages'),
      vi.spyOn(d.storage, 'saveMessagesIfAbsent'),
      vi.spyOn(d.storage, 'updateMessage'),
    ];

    d.messaging.beginBulkMessageIngest(DRAIN);
    await bodyFrame(d, PEER, 'm1', 'the deleted text');
    await deleteFrame(d, PEER, 'm1');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    const rows = d.shown();
    expect(rows).toHaveLength(1);
    // The bulk flush shows no server time (it never did); the stored row carries it.
    expect(rows[0]).toMatchObject({ id: 'm1', isDeleted: true });
    expect(rows[0].content).toBe(m.chat_system_message_deleted());
    const row = await d.storage.getMessage('m1', KEY);
    expect(row).toMatchObject({ isDeleted: true, serverTimestamp: 2_000 });
    expect(row?.content).toBe(m.chat_system_message_deleted());
    // The deleted text never reached the store, not even transiently.
    for (const spy of writes) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('the deleted');
    }
    expect((await pending(d.storage)).entries).toEqual([]);
  });

  it('finding 1 - a deletion that came first is no message row: not shown, not in the digest, not relayed', async () => {
    const d = await device();

    await deleteFrame(d, PEER, 'm1');

    expect(d.shown()).toEqual([]);
    // What the digest, the state key and a bundle are read from.
    expect(await d.storage.getMessages(CONVO, KEY)).toEqual([]);
    expect((await d.storage.getMessagesByIds(CONVO, ['m1'], KEY)).rows.size).toBe(0);
    expect((await pending(d.storage)).entries).toMatchObject([
      { messageId: 'm1', sender: PEER, kind: 'delete' },
    ]);
  });

  it("finding 7 - lets the message through when the deletion was not its author's, and drops that deletion", async () => {
    const d = await device();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    d.messaging.beginBulkMessageIngest(DRAIN);
    await bodyFrame(d, PEER, 'm1', 'a message');
    await deleteFrame(d, OTHER, 'm1');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(d.shown()).toHaveLength(1);
    expect(d.shown()[0]).toMatchObject({ id: 'm1', content: 'a message', senderId: PEER });
    expect(d.shown()[0].isDeleted).toBeFalsy();
    expect(await d.storage.getMessage('m1', KEY)).toMatchObject({ content: 'a message' });
    expect((await pending(d.storage)).entries).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('Discarded a delete');
  });

  it("finding 3 - a non-author's deletion, then the author's: the author's applies", async () => {
    const d = await device();

    await deleteFrame(d, OTHER, 'm1');
    await deleteFrame(d, PEER, 'm1');
    await bodyFrame(d, PEER, 'm1', 'the deleted text');

    expect(d.shown()[0]).toMatchObject({ id: 'm1', isDeleted: true });
    expect((await d.storage.getMessage('m1', KEY))?.content).toBe(m.chat_system_message_deleted());
    expect((await pending(d.storage)).entries).toEqual([]);
  });

  it("finding 4 - a non-author's far-future edit never displaces the author's", async () => {
    const d = await device();

    await editFrame(d, OTHER, 'm1', 'forged', 9e15);
    await editFrame(d, PEER, 'm1', 'the real edit', 5_000);
    await bodyFrame(d, PEER, 'm1', 'original');

    expect(d.shown()[0].content).toContain('the real edit');
    expect(d.shown()[0].isEdited).toBe(true);
    expect((await d.storage.getMessage('m1', KEY))?.content).toContain('the real edit');
    expect((await pending(d.storage)).entries).toEqual([]);
  });

  it('finding 2 - a deletion of a message from before this device was admitted shows nothing', async () => {
    const d = await device();
    // Admitted at 10 000: everything older is below the floor and is never answered.
    d.conversations.set(CONVO, { ...d.conversations.get(CONVO)!, historyFloor: 10_000 });

    await handleSystemEvent('delete_message', { messageId: 'm1' }, systemContext(d, PEER));

    expect(d.shown()).toEqual([]);
    expect(await d.storage.getMessages(CONVO, KEY)).toEqual([]);
    expect((await pending(d.storage)).entries).toEqual([]);
  });

  it('absorbs a body arriving LIVE after its deletion was kept', async () => {
    const d = await device();

    await deleteFrame(d, PEER, 'm1');
    await bodyFrame(d, PEER, 'm1', 'the deleted text');

    expect(d.shown()).toHaveLength(1);
    expect(d.shown()[0]).toMatchObject({ id: 'm1', isDeleted: true, serverTimestamp: 2_000 });
    expect((await d.storage.getMessage('m1', KEY))?.content).toBe(m.chat_system_message_deleted());
  });

  it('never upgrades a DELETED notification preview back into its body', async () => {
    const d = await device();
    // The push caption, in memory and at rest before the drain reached the body.
    const caption = {
      id: 'm1',
      senderId: PEER,
      content: 'caption',
      timestamp: new Date(2_000),
      isOwn: false,
      isFcmPreview: true,
    };
    d.conversations.set(CONVO, { ...d.conversations.get(CONVO)!, messages: [caption] });
    await d.storage.saveMessage(
      { id: 'm1', conversationId: CONVO, senderId: PEER, content: 'caption', timestamp: 2_000 },
      KEY
    );

    d.messaging.beginBulkMessageIngest(DRAIN);
    await deleteFrame(d, PEER, 'm1');
    await bodyFrame(d, PEER, 'm1', '{"kind":"text","text":"the deleted text"}');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(d.shown()[0]).toMatchObject({ id: 'm1', isDeleted: true });
    expect(d.shown()[0].content).toBe(m.chat_system_message_deleted());
    expect((await d.storage.getMessage('m1', KEY))?.content).toBe(m.chat_system_message_deleted());
  });

  it('an edit of a notification PREVIEW waits for the body, and the body arrives edited', async () => {
    const d = await device();
    const caption = {
      id: 'm1',
      senderId: PEER,
      content: 'caption',
      timestamp: new Date(2_000),
      isOwn: false,
      isFcmPreview: true,
    };
    d.conversations.set(CONVO, { ...d.conversations.get(CONVO)!, messages: [caption] });
    await d.storage.saveMessage(
      {
        id: 'm1',
        conversationId: CONVO,
        senderId: PEER,
        content: 'caption',
        timestamp: 2_000,
        isFcmPreview: true,
      },
      KEY
    );

    // The drain order of a device that was away: the preview is here, the edit is handled at once,
    // and the buffered body is flushed at the drain's end.
    d.messaging.beginBulkMessageIngest(DRAIN);
    await editFrame(d, PEER, 'm1', 'the edited text', 5_000);
    await bodyFrame(d, PEER, 'm1', '{"kind":"text","text":"the original text"}');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(d.shown()[0]).toMatchObject({ id: 'm1', isEdited: true });
    expect(d.shown()[0].content).toContain('the edited text');
    expect(d.shown()[0].isFcmPreview).toBeFalsy();
    const row = await d.storage.getMessage('m1', KEY);
    expect(row).toMatchObject({ isEdited: true, editedAt: 5_000 });
    expect(row?.content).toContain('the edited text');
    expect((await pending(d.storage)).entries).toEqual([]);
  });

  it('a signed edit a bundle laid on a stored PREVIEW survives the body arriving', async () => {
    const d = await device();
    // What a bundle merge leaves: the preview, edited (`mergeVettedRow`).
    const edited = '{"kind":"text","text":"the edited text"}';
    d.conversations.set(CONVO, {
      ...d.conversations.get(CONVO)!,
      messages: [
        {
          id: 'm1',
          senderId: PEER,
          content: edited,
          timestamp: new Date(2_000),
          isOwn: false,
          isFcmPreview: true,
          isEdited: true,
          editedAt: new Date(5_000),
        },
      ],
    });
    await d.storage.saveMessage(
      {
        id: 'm1',
        conversationId: CONVO,
        senderId: PEER,
        content: edited,
        timestamp: 2_000,
        isFcmPreview: true,
        isEdited: true,
        editedAt: 5_000,
      },
      KEY
    );

    d.messaging.beginBulkMessageIngest(DRAIN);
    await bodyFrame(d, PEER, 'm1', '{"kind":"text","text":"the original text"}');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(d.shown()[0].content).toContain('the edited text');
    const row = await d.storage.getMessage('m1', KEY);
    expect(row?.content).toContain('the edited text');
    expect(row).toMatchObject({ isEdited: true, editedAt: 5_000 });
    expect(row?.isFcmPreview).toBeFalsy();
  });

  it('an edit of a preview an OLDER build stored unflagged waits for the body too', async () => {
    const d = await device();
    await d.storage.saveMessage(
      { id: 'm1', conversationId: CONVO, senderId: PEER, content: 'caption', timestamp: 2_000 },
      KEY
    );

    await editFrame(d, PEER, 'm1', 'the edited text', 5_000);
    expect((await d.storage.getMessage('m1', KEY))?.isEdited).toBeFalsy();
    expect((await pending(d.storage)).entries).toMatchObject([{ kind: 'edit' }]);
    await bodyFrame(d, PEER, 'm1', '{"kind":"text","text":"the original text"}');

    expect((await d.storage.getMessage('m1', KEY))?.content).toContain('the edited text');
    expect((await pending(d.storage)).entries).toEqual([]);
  });

  it('keeps an edit across a restart - the store, not memory, holds it', async () => {
    const first = await device();
    await editFrame(first, PEER, 'm1', 'edited before arrival', 5_000);

    const { storage } = await openStore(first.name);
    const again = makeDevice(useMessaging, storage);
    await bodyFrame(again, PEER, 'm1', 'original');

    expect(again.shown()[0].content).toContain('edited before arrival');
    expect((await storage.getMessage('m1', KEY))?.content).toContain('edited before arrival');
  });

  it('keeps a legacy remove_reaction whose message is not here yet, through the one reaction path', async () => {
    const d = await device();
    await reactionFrame(d, OTHER, 'm1', '👍', 1_000);

    await handleSystemEvent(
      'remove_reaction',
      { messageId: 'm1', emoji: '👍' },
      systemContext(d, OTHER)
    );
    await bodyFrame(d, PEER, 'm1', 'a message');

    expect(d.messaging.messageReactions.get('m1')).toEqual([
      expect.objectContaining({ emoji: '👍', userId: OTHER, removed: true }),
    ]);
    expect((await d.storage.getMessage('m1', KEY))?.reactions).toEqual([
      expect.objectContaining({ emoji: '👍', userId: OTHER, removed: true }),
    ]);
  });

  it('item 9 - a reaction kept for a message another writer stored meanwhile reaches the stored row when the body comes as held', async () => {
    const d = await device();
    await reactionFrame(d, OTHER, 'm1', '🎉', 1_000);
    // Another writer (a bundle, the archive replay) stores the body without settling it.
    await d.storage.saveMessage(
      { id: 'm1', conversationId: CONVO, senderId: PEER, content: 'a message', timestamp: 2_000 },
      KEY
    );

    d.messaging.beginBulkMessageIngest(DRAIN);
    await bodyFrame(d, PEER, 'm1', 'a message');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect((await d.storage.getMessage('m1', KEY))?.reactions).toEqual([
      expect.objectContaining({ emoji: '🎉', userId: OTHER }),
    ]);
    expect((await pending(d.storage)).entries).toEqual([]);
  });
});

describe('the two races between a mutation handler and a message writer (finding 5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('5a - the body lands between the handler looking for it and keeping the deletion', async () => {
    const d = await device();
    const put = d.storage.putPendingMutation.bind(d.storage);
    vi.spyOn(d.storage, 'putPendingMutation').mockImplementationOnce(async (...args) => {
      // Another writer stores the body after the handler found nothing.
      await d.storage.saveMessages(
        [{ id: 'm1', conversationId: CONVO, senderId: PEER, content: 'body', timestamp: 2_000 }],
        KEY
      );
      return put(...args);
    });

    await deleteFrame(d, PEER, 'm1');

    expect(await d.storage.getMessage('m1', KEY)).toMatchObject({ isDeleted: true });
    expect((await pending(d.storage)).entries).toEqual([]);
  });

  it('5b - a tombstone lands between the writer reading the store and writing the body', async () => {
    const d = await device();
    const write = d.storage.saveMessagesIfAbsent.bind(d.storage);
    vi.spyOn(d.storage, 'saveMessagesIfAbsent').mockImplementationOnce(async (...args) => {
      await d.storage.saveMessage(
        {
          id: 'm1',
          conversationId: CONVO,
          senderId: PEER,
          content: m.chat_system_message_deleted(),
          isDeleted: true,
          timestamp: 2_000,
        },
        KEY
      );
      return write(...args);
    });

    d.messaging.beginBulkMessageIngest(DRAIN);
    await bodyFrame(d, PEER, 'm1', 'the deleted text');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(await d.storage.getMessage('m1', KEY)).toMatchObject({ isDeleted: true });
    expect(d.shown()[0]).toMatchObject({ id: 'm1', isDeleted: true });
  });

  it('5b - a deletion is kept between the writer reading the pending entries and writing the body', async () => {
    const d = await device();
    const write = d.storage.saveMessagesIfAbsent.bind(d.storage);
    vi.spyOn(d.storage, 'saveMessagesIfAbsent').mockImplementationOnce(async (...args) => {
      await deleteFrame(d, PEER, 'm1');
      return write(...args);
    });

    d.messaging.beginBulkMessageIngest(DRAIN);
    await bodyFrame(d, PEER, 'm1', 'the deleted text');
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(await d.storage.getMessage('m1', KEY)).toMatchObject({ isDeleted: true });
    expect(d.shown()[0]).toMatchObject({ id: 'm1', isDeleted: true });
    expect((await pending(d.storage)).entries).toEqual([]);
  });
});

describe('a mutation kept before its message, met by a relayed copy (findings 6 and 7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /** A `history_bundle` relayed by `relayer`, carrying `m1` as written by `sender`. */
  const bundle = (d: Awaited<ReturnType<typeof device>>, relayer: string, sender: string) =>
    handleSystemEvent(
      'history_bundle',
      { messages: [{ id: 'm1', senderId: sender, content: 'hello', timestamp: 1_000 }] },
      systemContext(d, relayer)
    );

  it("finding 6 - the author's own relay settles the author's deletion, and accuses nobody", async () => {
    const d = await device();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await deleteFrame(d, PEER, 'm1');

    await bundle(d, PEER, PEER);

    expect(await d.storage.getMessage('m1', KEY)).toMatchObject({
      isDeleted: true,
      content: m.chat_system_message_deleted(),
    });
    expect((await pending(d.storage)).entries).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("finding 7 - an unverified copy of the author's message is shown, whatever a non-author deleted", async () => {
    const d = await device();
    await deleteFrame(d, OTHER, 'm1');

    // Relayed unsigned by somebody who is not its author: kept as unverified, never suppressed.
    await bundle(d, 'carol', PEER);

    const row = await d.storage.getMessage('m1', KEY);
    expect(row).toMatchObject({ senderId: PEER, content: 'hello' });
    expect(row?.isDeleted).toBeFalsy();
    // RETAINED, not discarded: the copy's author is a claim nobody proved, so a deletion by
    // someone else may be the real author's - it waits for a proven copy (review of #2936, P3).
    expect((await pending(d.storage)).entries).toMatchObject([{ sender: OTHER, kind: 'delete' }]);
  });
});
