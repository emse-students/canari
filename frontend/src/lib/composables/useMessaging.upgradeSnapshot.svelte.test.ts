/**
 * A PREVIEW UPGRADE WRITES OVER THE CONVERSATION AS IT IS AFTER ITS AWAIT, NOT AS IT WAS BEFORE
 * (owner's Android 1.6.8 reading, 2026-11-09).
 *
 * The live path's upgrade of a notification preview reads the conversation, awaits the mutations
 * that may wait for the body (`settleWithPending`, an IndexedDB read), then writes the conversation
 * back. At a notification-tap open that await overlaps the stored page being drawn
 * (`renderStoredPage`): whatever lands in the map during it must survive the upgrade's write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import type { ChatMessage, MessageReaction } from '$lib/types';
import { CONVO, makeDevice, freshStoreName } from './pendingMutations.test-helper';

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

const PEER = 'peer-user-id';

const row = (id: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  senderId: PEER,
  content: `text of ${id}`,
  timestamp: new Date(at),
  isOwn: false,
  ...extra,
});

describe('the live upgrade of a shown preview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('keeps the rows another writer put in the conversation during its await', async () => {
    const storage = new IndexedDbStorage(freshStoreName());
    await storage.init();
    const d = makeDevice(useMessaging, storage);
    d.conversations.set(CONVO, {
      ...d.conversations.get(CONVO)!,
      messages: [row('p1', 5_000, { content: 'caption', isFcmPreview: true })],
    });

    // The stored page lands while the upgrade waits on the store - what `renderStoredPage` does
    // at a notification-tap open, between the preview being shown and its body arriving.
    const read = storage.getPendingMutations.bind(storage);
    const during = vi
      .spyOn(storage, 'getPendingMutations')
      .mockImplementationOnce(async (...args) => {
        const current = d.conversations.get(CONVO)!;
        d.conversations.set(CONVO, {
          ...current,
          messages: [row('s1', 1_000), row('s2', 2_000), ...current.messages],
        });
        return read(...args);
      });

    await d.messaging.addMessageToChat(
      PEER,
      '{"kind":"text","text":"the real body"}',
      CONVO,
      d.ctx,
      { messageId: 'p1', serverTimestamp: 5_000 }
    );

    expect(during).toHaveBeenCalled();
    const shown = d.shown();
    expect(shown.map((m) => m.id)).toEqual(['s1', 's2', 'p1']);
    expect(shown[2].isFcmPreview).toBeFalsy();
    expect(shown[2].content).toContain('the real body');
  });

  /** Replaces the conversation's rows while the upgrade waits on the store, as the stored page does. */
  function landDuring(
    storage: IndexedDbStorage,
    d: ReturnType<typeof makeDevice>,
    rows: (current: ChatMessage[]) => ChatMessage[]
  ) {
    const read = storage.getPendingMutations.bind(storage);
    return vi.spyOn(storage, 'getPendingMutations').mockImplementationOnce(async (...args) => {
      const current = d.conversations.get(CONVO)!;
      d.conversations.set(CONVO, { ...current, messages: rows(current.messages) });
      return read(...args);
    });
  }

  it('lands the body ONTO the stored copy of the preview, keeping what that copy carried', async () => {
    const storage = new IndexedDbStorage(freshStoreName());
    await storage.init();
    const d = makeDevice(useMessaging, storage);
    d.conversations.set(CONVO, {
      ...d.conversations.get(CONVO)!,
      messages: [row('p1', 5_000, { content: 'caption', isFcmPreview: true })],
    });
    const reaction: MessageReaction = { emoji: 'plus-one', userId: 'someone', at: 4_000 };
    const during = landDuring(storage, d, () => [
      row('p1', 5_000, { content: 'caption', isFcmPreview: true, reactions: [reaction] }),
    ]);

    await d.messaging.addMessageToChat(
      PEER,
      '{"kind":"text","text":"the real body"}',
      CONVO,
      d.ctx,
      { messageId: 'p1', serverTimestamp: 5_000 }
    );

    expect(during).toHaveBeenCalled();
    const [shown] = d.shown();
    expect(shown.isFcmPreview).toBeFalsy();
    expect(shown.content).toContain('the real body');
    expect(shown.reactions).toEqual([reaction]);
  });

  it('leaves a copy that is no longer a preview - a tombstone - as it is', async () => {
    const storage = new IndexedDbStorage(freshStoreName());
    await storage.init();
    const d = makeDevice(useMessaging, storage);
    d.conversations.set(CONVO, {
      ...d.conversations.get(CONVO)!,
      messages: [row('p1', 5_000, { content: 'caption', isFcmPreview: true })],
    });
    landDuring(storage, d, () => [
      row('p1', 5_000, { content: 'deleted', isFcmPreview: true, isDeleted: true }),
    ]);

    await d.messaging.addMessageToChat(
      PEER,
      '{"kind":"text","text":"the real body"}',
      CONVO,
      d.ctx,
      { messageId: 'p1', serverTimestamp: 5_000 }
    );

    const [shown] = d.shown();
    expect(shown.isDeleted).toBe(true);
    expect(shown.content).not.toContain('the real body');
  });
});
