/**
 * A CONVERSATION REEL'S 410, RECORDED (RC-6, reels-in-chat 15.4): on the message in memory, so every
 * later render of the row draws the tombstone, and on its LOCAL row, so a reload does too - one 410
 * per message per device, never one per scroll. The first instant is kept.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

await import('./useMessaging.svelte');

import type { ChatMessage, Conversation } from '$lib/types';
import type { StoredMessage, StoredMessagePatch } from '$lib/db/types';
import { mergeStoredMessage } from '$lib/db/messagePayload';
import { forgetConversationMoves, recordConversationMove } from '$lib/utils/chat/conversationMoves';

type MessagingContext = import('./useMessaging.svelte').MessagingContext;

const DM = 'alice';
const OTHER = 'bob';

function msg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, senderId: DM, content: '{}', timestamp: new Date(1), isOwn: false, ...extra };
}

/**
 * A storage whose rows merge patches the way both engines do (`mergeStoredMessage`), and whose
 * reads and writes are SCOPED to a conversation like the real ones: the same id may stand in two.
 */
function fakeStorage(rows: StoredMessage[]) {
  const byKey = new Map(rows.map((r) => [`${r.conversationId}/${r.id}`, r]));
  return {
    /** The row of `id` whatever its conversation (the first one), for the single-row cases. */
    rows: { get: (id: string) => [...byKey.values()].find((r) => r.id === id) },
    rowOf: (conversationId: string, id: string) => byKey.get(`${conversationId}/${id}`),
    updateMessage: vi.fn(async (c: string, id: string, patch: StoredMessagePatch) => {
      const row = byKey.get(`${c}/${id}`);
      if (row) byKey.set(`${c}/${id}`, mergeStoredMessage(row, patch));
    }),
    getMessagesByIds: vi.fn(async (c: string, ids: string[]) => {
      const out = new Map<string, StoredMessage>();
      for (const id of ids) {
        const row = byKey.get(`${c}/${id}`);
        if (row) out.set(id, row);
      }
      return { rows: out, unreadable: new Set<string>() };
    }),
    getMessage: vi.fn(async (c: string, id: string) => byKey.get(`${c}/${id}`) ?? null),
  };
}

function ctxFor(messages: Record<string, ChatMessage[]>, storage: unknown, selected = DM) {
  const conversations = new SvelteMap<string, Conversation>(
    Object.entries(messages).map(([id, msgs]) => [
      id,
      { id, name: id, messages: msgs, unreadCount: 0, lastMessageAt: 0 } as never,
    ])
  );
  const ctx = {
    conversations,
    userId: 'me',
    deviceKeyB64: 'k',
    storage,
    selectedNow: () => selected,
    log: vi.fn(),
  } as unknown as MessagingContext;
  return ctx;
}

const row = (id: string, conversationId: string, extra: Partial<StoredMessage> = {}) =>
  ({ id, conversationId, senderId: DM, content: '{}', timestamp: 1, ...extra }) as StoredMessage;

describe('recordReelPurged', () => {
  afterEach(() => forgetConversationMoves());

  it('writes the instant on the message in memory AND on its row, and says it is on disk', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM)]);
    const ctx = ctxFor({ [DM]: [msg('r0'), msg('r1')] }, storage);
    await useMessaging().recordReelPurged(DM, 'r1', 1234, ctx);
    expect(ctx.conversations.get(DM)!.messages[1].mediaPurgedAt).toBe(1234);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.rows.get('r1')!.mediaPurgedAt).toBe(1234);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('recorded on its row'));
  });

  it('writes the message of the conversation it is named, even when another is on screen', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r9', OTHER)]);
    const ctx = ctxFor({ [DM]: [msg('r1')], [OTHER]: [msg('r9')] }, storage);
    await useMessaging().recordReelPurged(OTHER, 'r9', 55, ctx);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(55);
  });

  it('keeps the FIRST instant: a message already carrying one is left alone', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM, { mediaPurgedAt: 10 })]);
    const ctx = ctxFor({ [DM]: [msg('r1', { mediaPurgedAt: 10 })] }, storage);
    await useMessaging().recordReelPurged(DM, 'r1', 99, ctx);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBe(10);
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });

  it('a second record never overwrites the STORED first, even when memory does not hold it', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM)]);
    const messaging = useMessaging();
    await messaging.recordReelPurged(DM, 'r1', 100, ctxFor({ [DM]: [msg('r1')] }, storage));
    // Another page life: memory no longer carries it (a reload not yet re-read, another tab).
    const later = ctxFor({ [DM]: [msg('r1')] }, storage);
    await messaging.recordReelPurged(DM, 'r1', 900, later);
    expect(storage.rows.get('r1')!.mediaPurgedAt).toBe(100);
    expect(storage.updateMessage).toHaveBeenCalledTimes(1);
    // Memory is aligned to the stored first instant, not left on the later one.
    expect(later.conversations.get(DM)!.messages[0].mediaPurgedAt).toBe(100);
    expect(later.log).toHaveBeenCalledWith(expect.stringContaining('the first kept'));
  });

  it('with the message in no loaded conversation, still writes its row, and keeps a first instant', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r5', DM), row('r6', DM, { mediaPurgedAt: 3 })]);
    const ctx = ctxFor({ [DM]: [] }, storage);
    const messaging = useMessaging();
    await messaging.recordReelPurged(DM, 'r5', 8, ctx);
    await messaging.recordReelPurged(DM, 'r6', 8, ctx);
    expect(storage.rows.get('r5')!.mediaPurgedAt).toBe(8);
    expect(storage.rows.get('r6')!.mediaPurgedAt).toBe(3);
    expect(storage.updateMessage).toHaveBeenCalledTimes(1);
  });

  it('the same id in two conversations: only the named one is recorded, in memory and on its row', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM)]);
    const ctx = ctxFor({ [DM]: [msg('r1')], [OTHER]: [msg('r1')] }, storage, OTHER);
    await useMessaging().recordReelPurged(DM, 'r1', 42, ctx);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBe(42);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.updateMessage).toHaveBeenCalledWith(DM, 'r1', { mediaPurgedAt: 42 }, 'k');
  });

  it('says, with its cost, a row it could not write (absent or unreadable)', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([]);
    const ctx = ctxFor({ [DM]: [msg('r1')] }, storage);
    await useMessaging().recordReelPurged(DM, 'r1', 7, ctx);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('NOT persisted'));
  });

  it('patches memory AND disk only in the conversation it was opened from, though another is selected and holds the same id first', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    // The peer's row (DM, first in the map, SELECTED) and mine (OTHER) share an id.
    const storage = fakeStorage([row('dup', DM), row('dup', OTHER)]);
    const ctx = ctxFor({ [DM]: [msg('dup')], [OTHER]: [msg('dup')] }, storage, DM);
    await useMessaging().recordReelPurged(OTHER, 'dup', 77, ctx);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(77);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.rowOf(OTHER, 'dup')!.mediaPurgedAt).toBe(77);
    expect(storage.rowOf(DM, 'dup')!.mediaPurgedAt).toBeUndefined();
    expect(storage.updateMessage).toHaveBeenCalledWith(OTHER, 'dup', expect.anything(), 'k');
  });

  it('aligns a stored first instant only in the conversation it was opened from', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('dup', DM), row('dup', OTHER, { mediaPurgedAt: 5 })]);
    const ctx = ctxFor({ [DM]: [msg('dup')], [OTHER]: [msg('dup')] }, storage, DM);
    await useMessaging().recordReelPurged(OTHER, 'dup', 900, ctx);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(5);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });

  it('follows a re-key: a key the thread moved away from still reaches it, in memory and on disk', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    recordConversationMove('old-key', OTHER);
    const storage = fakeStorage([row('dup', DM), row('dup', OTHER)]);
    const ctx = ctxFor({ [DM]: [msg('dup')], [OTHER]: [msg('dup')] }, storage, DM);
    await useMessaging().recordReelPurged('old-key', 'dup', 31, ctx);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(31);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.rowOf(OTHER, 'dup')!.mediaPurgedAt).toBe(31);
    expect(storage.rowOf(DM, 'dup')!.mediaPurgedAt).toBeUndefined();
  });

  it('a key whose conversation does not hold the row accuses and touches neither memory nor disk', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage([row('dup', DM)]);
    const ctx = ctxFor({ [DM]: [msg('dup')], [OTHER]: [] }, storage);
    await useMessaging().recordReelPurged(OTHER, 'dup', 7, ctx);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.updateMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not hold the row'));
    warn.mockRestore();
  });
});
