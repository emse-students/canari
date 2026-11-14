/**
 * A MUTATION REACHES ITS MESSAGE WHEREVER THE MESSAGE IS (2026-11-02, the follow-up of the owner's
 * deleted-message report), against a REAL local store.
 *
 * Memory is a window: the boot restore seeds every conversation with `messages: []`, and an opened
 * one holds its last page. An edit or a reaction whose message was stored but not shown, or still
 * in a catch-up drain's buffer, was dropped; and a body re-delivered for a stored row that memory
 * did not show was written over that row whole - its tombstone included.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { envelopeBodyText, mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import type { StoredMessage } from '$lib/db/types';
import {
  CONVO,
  DRAIN,
  KEY,
  OTHER_KEY,
  deleteFrame,
  editFrame,
  makeDevice,
  freshStoreName,
  reactionFrame,
  systemContext,
} from './pendingMutations.test-helper';
import { handleSystemEvent } from '$lib/mls-client/messagePipeline/systemMessageHandler';

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
const BODY = serializeEnvelope(mkTextEnvelope('original'));

async function device() {
  return makeDevice(useMessaging, (await openStore()).storage);
}

const storedBody = (extra: Partial<StoredMessage> = {}): StoredMessage => ({
  id: 'm1',
  conversationId: CONVO,
  senderId: PEER,
  content: BODY,
  timestamp: 1_000,
  ...extra,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('an edit whose message is stored but not shown', () => {
  it('rewrites the STORED row', async () => {
    const d = await device();
    await d.storage.saveMessage(storedBody(), KEY);

    await editFrame(d, PEER, 'm1', 'rewritten', 4_000);

    const row = await d.storage.getMessage('m1', KEY);
    expect(envelopeBodyText(row!.content)).toBe('rewritten');
    expect(row).toMatchObject({ isEdited: true, editedAt: 4_000 });
  });

  it('refuses it from anybody but the author, and never touches a stored tombstone', async () => {
    const d = await device();
    await d.storage.saveMessage(storedBody(), KEY);
    await d.storage.saveMessage(storedBody({ id: 'm2', isDeleted: true, content: 'deleted' }), KEY);

    await editFrame(d, OTHER, 'm1', 'forged', 4_000);
    await editFrame(d, PEER, 'm2', 'back from the dead', 4_000);

    expect((await d.storage.getMessage('m1', KEY))?.content).toBe(BODY);
    expect((await d.storage.getMessage('m2', KEY))?.content).toBe('deleted');
  });
});

describe('an edit delivered in the same drain as its message', () => {
  it('lands with the body - shown and stored edited', async () => {
    const d = await device();

    d.messaging.beginBulkMessageIngest(DRAIN);
    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, {
      messageId: 'm1',
      serverTimestamp: 2_000,
    });
    await editFrame(d, PEER, 'm1', 'rewritten', 4_000);
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(envelopeBodyText(d.shown()[0].content)).toBe('rewritten');
    expect(d.shown()[0].isEdited).toBe(true);
    const row = await d.storage.getMessage('m1', KEY);
    expect(envelopeBodyText(row!.content)).toBe('rewritten');
    expect(row).toMatchObject({ isEdited: true, editedAt: 4_000 });
  });

  it("drops it when the editor is not the body's author", async () => {
    const d = await device();

    d.messaging.beginBulkMessageIngest(DRAIN);
    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, { messageId: 'm1' });
    await editFrame(d, OTHER, 'm1', 'forged', 4_000);
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    expect(envelopeBodyText(d.shown()[0].content)).toBe('original');
    expect((await d.storage.getMessage('m1', KEY))?.isEdited).toBeFalsy();
    expect((await d.storage.getPendingMutations(CONVO, ['m1'], KEY)).entries).toEqual([]);
  });
});

describe('a reaction whose message is not shown', () => {
  it('is merged into the STORED row', async () => {
    const d = await device();
    await d.storage.saveMessage(storedBody(), KEY);

    await reactionFrame(d, OTHER, 'm1', '👍', 5_000);

    expect((await d.storage.getMessage('m1', KEY))?.reactions).toEqual([
      expect.objectContaining({ userId: OTHER, emoji: '👍' }),
    ]);
  });

  it('lands with the body when both came in one drain', async () => {
    const d = await device();

    d.messaging.beginBulkMessageIngest(DRAIN);
    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, { messageId: 'm1' });
    await reactionFrame(d, OTHER, 'm1', '👍', 5_000);
    await d.messaging.endBulkMessageIngest(d.ctx, DRAIN);

    const expected = [expect.objectContaining({ userId: OTHER, emoji: '👍' })];
    expect(d.shown()[0].reactions).toEqual(expected);
    expect((await d.storage.getMessage('m1', KEY))?.reactions).toEqual(expected);
  });
});

describe('a body re-delivered for a stored row memory does not show', () => {
  it('never writes over a stored TOMBSTONE - not through a batch, not live', async () => {
    const d = await device();
    await d.storage.saveMessage(
      storedBody({ isDeleted: true, content: m.chat_system_message_deleted() }),
      KEY
    );
    await d.storage.saveMessage(storedBody({ id: 'm2', isDeleted: true, content: 'deleted' }), KEY);

    // A broadcast or join bundle restating old history goes through the batch.
    await d.messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'm1' }],
      CONVO,
      d.ctx,
      'restore'
    );
    await d.messaging.addMessageToChat(PEER, BODY, CONVO, d.ctx, { messageId: 'm2' });

    const m1 = await d.storage.getMessage('m1', KEY);
    expect(m1).toMatchObject({ isDeleted: true, content: m.chat_system_message_deleted() });
    expect(await d.storage.getMessage('m2', KEY)).toMatchObject({
      isDeleted: true,
      content: 'deleted',
    });
  });

  it("keeps a stored row's edit and reactions, and leaves a row it cannot open alone", async () => {
    const d = await device();
    const reacted = [{ userId: OTHER, emoji: '👍', at: 1 }];
    await d.storage.saveMessage(
      storedBody({ isEdited: true, editedAt: 3, reactions: reacted }),
      KEY
    );
    await d.storage.saveMessage(storedBody({ id: 'm3', content: 'sealed elsewhere' }), OTHER_KEY);
    const rewrite = vi.spyOn(d.storage, 'saveMessages');

    await d.messaging.batchAddMessages(
      [
        { senderId: PEER, content: BODY, messageId: 'm1' },
        { senderId: PEER, content: BODY, messageId: 'm3' },
      ],
      CONVO,
      d.ctx,
      'restore'
    );

    expect(await d.storage.getMessage('m1', KEY)).toMatchObject({
      isEdited: true,
      reactions: reacted,
    });
    expect(await d.storage.getMessage('m3', OTHER_KEY)).toMatchObject({
      content: 'sealed elsewhere',
    });
    expect(rewrite).not.toHaveBeenCalled();
  });
});

describe('a frame of one conversation naming a message of ANOTHER (review of #2936, P1)', () => {
  // A message id is global in the store. A member of A who is (or was) also in B must not reach a
  // row of B through a frame sent in A - deleting, editing or reacting to it there, or a relayed
  // bundle rewriting it. A row of another conversation reads as ABSENT to every one of them.
  const IN_B = 'conversation-b';
  const rowOfB = () => storedBody({ id: 'b1', conversationId: IN_B, content: BODY });

  async function deviceWithRowOfB() {
    const d = await device();
    await d.storage.saveConversation({ id: IN_B, name: 'b', lifecycle: 'active', updatedAt: 1 });
    await d.storage.saveMessage(rowOfB(), KEY);
    return d;
  }

  async function rowOfBAfter() {
    return (await d0!.storage.getMessagesByIds(IN_B, ['b1'], KEY)).rows.get('b1');
  }
  let d0: Awaited<ReturnType<typeof deviceWithRowOfB>> | null = null;

  it('a deletion sent in A never tombstones it', async () => {
    d0 = await deviceWithRowOfB();
    await deleteFrame(d0, PEER, 'b1');
    expect(await rowOfBAfter()).toMatchObject({ content: BODY });
    expect((await rowOfBAfter())?.isDeleted).toBeFalsy();
  });

  it('an edit sent in A never rewrites it', async () => {
    d0 = await deviceWithRowOfB();
    await editFrame(d0, PEER, 'b1', 'rewritten through A', 4_000);
    expect(await rowOfBAfter()).toMatchObject({ content: BODY });
    expect((await rowOfBAfter())?.isEdited).toBeFalsy();
  });

  it('a reaction sent in A never lands on it', async () => {
    d0 = await deviceWithRowOfB();
    await reactionFrame(d0, OTHER, 'b1', '👍', 5_000);
    expect((await rowOfBAfter())?.reactions ?? []).toEqual([]);
  });

  it('a bundle relayed in A never merges onto it', async () => {
    d0 = await deviceWithRowOfB();
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'b1',
            senderId: PEER,
            content: m.chat_system_message_deleted(),
            timestamp: 1_000,
            isDeleted: true,
          },
        ],
      },
      systemContext(d0, PEER)
    );
    expect(await rowOfBAfter()).toMatchObject({ content: BODY });
    expect((await rowOfBAfter())?.isDeleted).toBeFalsy();
  });
});
