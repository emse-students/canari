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
import { CONVO, KEY, makeDevice, freshStoreName } from './pendingMutations.test-helper';

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

/** A device whose first store read runs `during` before it answers - the other writer's gap. */
async function deviceWithGap(during: (d: ReturnType<typeof makeDevice>) => void) {
  const storage = new IndexedDbStorage(freshStoreName());
  await storage.init();
  const d = makeDevice(useMessaging, storage);
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
