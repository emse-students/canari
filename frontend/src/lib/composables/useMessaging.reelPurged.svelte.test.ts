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
    await useMessaging().recordReelPurged('r1', 1234, ctx, DM);
    expect(ctx.conversations.get(DM)!.messages[1].mediaPurgedAt).toBe(1234);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.rows.get('r1')!.mediaPurgedAt).toBe(1234);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('recorded on its row'));
  });

  it('finds the message in a conversation that is not the one on screen', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r9', OTHER)]);
    const ctx = ctxFor({ [DM]: [msg('r1')], [OTHER]: [msg('r9')] }, storage);
    await useMessaging().recordReelPurged('r9', 55, ctx, OTHER);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(55);
  });

  it('keeps the FIRST instant: a message already carrying one is left alone', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM, { mediaPurgedAt: 10 })]);
    const ctx = ctxFor({ [DM]: [msg('r1', { mediaPurgedAt: 10 })] }, storage);
    await useMessaging().recordReelPurged('r1', 99, ctx, DM);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBe(10);
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });

  it('a second record never overwrites the STORED first, even when memory does not hold it', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM)]);
    const messaging = useMessaging();
    await messaging.recordReelPurged('r1', 100, ctxFor({ [DM]: [msg('r1')] }, storage), DM);
    // Another page life: memory no longer carries it (a reload not yet re-read, another tab).
    const later = ctxFor({ [DM]: [msg('r1')] }, storage);
    await messaging.recordReelPurged('r1', 900, later, DM);
    expect(storage.rows.get('r1')!.mediaPurgedAt).toBe(100);
    expect(storage.updateMessage).toHaveBeenCalledTimes(1);
    // Memory is aligned to the stored first instant, not left on the later one.
    expect(later.conversations.get(DM)!.messages[0].mediaPurgedAt).toBe(100);
    expect(later.log).toHaveBeenCalledWith(expect.stringContaining('the first kept'));
  });

  it('with the message in no loaded conversation, still records it on the row, once', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r5', DM, { mediaPurgedAt: 3 })]);
    const ctx = ctxFor({ [DM]: [] }, storage);
    await useMessaging().recordReelPurged('r5', 8, ctx, DM);
    expect(storage.rows.get('r5')!.mediaPurgedAt).toBe(3);
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });

  it('says, with its cost, a row it could not write (absent or unreadable)', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([]);
    const ctx = ctxFor({ [DM]: [msg('r1')] }, storage);
    await useMessaging().recordReelPurged('r1', 7, ctx, DM);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('NOT persisted'));
  });

  it('patches memory AND disk only in the conversation it was opened from, though another is selected and holds the same id first', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    // The peer's row (DM, first in the map, SELECTED) and mine (OTHER) share an id.
    const storage = fakeStorage([row('dup', DM), row('dup', OTHER)]);
    const ctx = ctxFor({ [DM]: [msg('dup')], [OTHER]: [msg('dup')] }, storage, DM);
    await useMessaging().recordReelPurged('dup', 77, ctx, OTHER);
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
    await useMessaging().recordReelPurged('dup', 900, ctx, OTHER);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(5);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });

  it('follows a re-key: a key the thread moved away from still reaches it, in memory and on disk', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    recordConversationMove('old-key', OTHER);
    const storage = fakeStorage([row('dup', DM), row('dup', OTHER)]);
    const ctx = ctxFor({ [DM]: [msg('dup')], [OTHER]: [msg('dup')] }, storage, DM);
    await useMessaging().recordReelPurged('dup', 31, ctx, 'old-key');
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(31);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.rowOf(OTHER, 'dup')!.mediaPurgedAt).toBe(31);
    expect(storage.rowOf(DM, 'dup')!.mediaPurgedAt).toBeUndefined();
  });

  it('with no conversation key, accuses and touches neither memory nor disk', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage([row('dup', DM)]);
    const ctx = ctxFor({ [DM]: [msg('dup')] }, storage);
    await useMessaging().recordReelPurged('dup', 7, ctx, null);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.updateMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no conversation key'));
    warn.mockRestore();
  });
});
