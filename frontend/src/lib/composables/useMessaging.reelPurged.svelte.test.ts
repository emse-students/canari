/**
 * A CONVERSATION REEL'S 410, RECORDED (RC-6, reels-in-chat 15.4): on the message in memory, so every
 * later render of the row draws the tombstone, and on its LOCAL row, so a reload does too - one 410
 * per message per device, never one per scroll. The first instant is kept.
 */
import { describe, expect, it, vi } from 'vitest';
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

type MessagingContext = import('./useMessaging.svelte').MessagingContext;

const DM = 'alice';
const OTHER = 'bob';

function msg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, senderId: DM, content: '{}', timestamp: new Date(1), isOwn: false, ...extra };
}

/** A storage whose rows merge patches the way both engines do (`mergeStoredMessage`). */
function fakeStorage(rows: StoredMessage[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    rows: byId,
    updateMessage: vi.fn(async (id: string, patch: StoredMessagePatch) => {
      const row = byId.get(id);
      if (row) byId.set(id, mergeStoredMessage(row, patch));
    }),
    getMessage: vi.fn(async (id: string) => byId.get(id) ?? null),
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
  it('writes the instant on the message in memory AND on its row, and says it is on disk', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM)]);
    const ctx = ctxFor({ [DM]: [msg('r0'), msg('r1')] }, storage);
    await useMessaging().recordReelPurged('r1', 1234, ctx);
    expect(ctx.conversations.get(DM)!.messages[1].mediaPurgedAt).toBe(1234);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBeUndefined();
    expect(storage.rows.get('r1')!.mediaPurgedAt).toBe(1234);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('recorded on its row'));
  });

  it('finds the message in a conversation that is not the one on screen', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r9', OTHER)]);
    const ctx = ctxFor({ [DM]: [msg('r1')], [OTHER]: [msg('r9')] }, storage);
    await useMessaging().recordReelPurged('r9', 55, ctx);
    expect(ctx.conversations.get(OTHER)!.messages[0].mediaPurgedAt).toBe(55);
  });

  it('keeps the FIRST instant: a message already carrying one is left alone', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([row('r1', DM, { mediaPurgedAt: 10 })]);
    const ctx = ctxFor({ [DM]: [msg('r1', { mediaPurgedAt: 10 })] }, storage);
    await useMessaging().recordReelPurged('r1', 99, ctx);
    expect(ctx.conversations.get(DM)!.messages[0].mediaPurgedAt).toBe(10);
    expect(storage.updateMessage).not.toHaveBeenCalled();
  });

  it('says, with its cost, a row it could not write (absent or unreadable)', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const storage = fakeStorage([]);
    const ctx = ctxFor({ [DM]: [msg('r1')] }, storage);
    await useMessaging().recordReelPurged('r1', 7, ctx);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('NOT persisted'));
  });
});
