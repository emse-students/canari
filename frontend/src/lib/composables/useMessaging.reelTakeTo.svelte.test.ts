/**
 * ONE TAKE, N SENDS (reels-in-chat RC-12, 15.1): `sendChatReelTakeTo` writes the take and one send
 * per target conversation in ONE `enqueueOutboxTake` call, draws one bubble per target, carries the
 * publish step's wait (`awaitsPublish`, its `takeId`), refuses to write a take nobody is sent to, and
 * writes nothing for a sign-out between the tap and the write. The chat camera's single conversation
 * is the one-target case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const signOut = vi.hoisted(() => ({ count: 0 }));
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  signOutGeneration: () => signOut.count,
}));

const enqueueTakeMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return {
    ...actual,
    enqueueOutboxTake: (...args: unknown[]) => enqueueTakeMock(...args),
    applyOutboxPendingStatuses: async () => {},
  };
});
vi.mock('$lib/reels/capturePoster', () => ({ capturePosterOf: () => null }));

import type { Conversation } from '$lib/types';
import type { OutboxEntry } from '$lib/db';
import { OutboxEnqueueError } from '$lib/utils/chat/outbox';
import { m } from '$lib/paraglide/messages';

type MessagingContext = import('./useMessaging.svelte').MessagingContext;

function convo(id: string): [string, Conversation] {
  return [
    `key-${id}`,
    {
      id,
      name: id,
      messages: [],
      unreadCount: 0,
      lastMessageAt: 0,
      lifecycle: 'active',
    } as never,
  ];
}

function makeContext() {
  return {
    conversations: new SvelteMap<string, Conversation>([convo('g-1'), convo('g-2'), convo('g-3')]),
    userId: 'me',
    selectedContact: 'key-g-1',
    selectedNow: () => 'key-g-1',
    setSendError: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    playSendTone: vi.fn(),
    storage: null,
    ensureMls: vi.fn(() => {
      throw new Error('the take path asked the MLS service');
    }),
  } as unknown as MessagingContext;
}

const take = () => new File([new Uint8Array(8)], 'take.mp4', { type: 'video/mp4' });

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

beforeEach(() => {
  signOut.count = 0;
  enqueueTakeMock.mockReset();
  enqueueTakeMock.mockResolvedValue(undefined);
});

describe('sendChatReelTakeTo', () => {
  it('writes ONE take and one send per target in a single enqueue', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const out = await messaging.sendChatReelTakeTo(take(), ['key-g-1', 'key-g-3'], ctx);

    expect(enqueueTakeMock).toHaveBeenCalledTimes(1);
    const [takeRow, sends, opts] = enqueueTakeMock.mock.calls[0] as [
      OutboxEntry,
      Array<{ entry: OutboxEntry }>,
      unknown,
    ];
    expect(takeRow.kind).toBe('reel-take');
    expect(sends.map((s) => s.entry.conversationId)).toEqual(['g-1', 'g-3']);
    expect(sends.every((s) => s.entry.media?.takeId === takeRow.id)).toBe(true);
    expect(takeRow.take?.sends.map((s) => s.conversationId)).toEqual(['g-1', 'g-3']);
    expect(opts).toBeUndefined();
    expect(out).toEqual({ takeId: takeRow.id, queued: 2 });
    // One bubble per target, filed under ITS conversation.
    expect(ctx.saveConversation).toHaveBeenCalledTimes(2);
    expect(ctx.conversations.get('key-g-1')!.messages).toHaveLength(1);
    expect(ctx.conversations.get('key-g-3')!.messages).toHaveLength(1);
    expect(ctx.conversations.get('key-g-2')!.messages).toHaveLength(0);
  });

  it("carries the publish step's wait and its take id, so the chats adopt that upload", async () => {
    const messaging = await freshMessaging();
    const out = await messaging.sendChatReelTakeTo(take(), ['key-g-1'], makeContext(), {
      takeId: 'take-from-the-sheet',
      awaitsPublish: true,
    });
    const [takeRow, , opts] = enqueueTakeMock.mock.calls[0] as [OutboxEntry, unknown, unknown];
    expect(takeRow.id).toBe('take-from-the-sheet');
    expect(opts).toEqual({ awaitsPublish: true });
    expect(out?.takeId).toBe('take-from-the-sheet');
  });

  it('sends a conversation named twice once, and skips one this device does not hold', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const out = await messaging.sendChatReelTakeTo(take(), ['key-g-2', 'key-g-2', 'gone'], ctx);
    expect(out?.queued).toBe(1);
    expect((enqueueTakeMock.mock.calls[0][1] as unknown[]).length).toBe(1);
  });

  it('writes nothing, and says so, when no target is held', async () => {
    const messaging = await freshMessaging();
    expect(await messaging.sendChatReelTakeTo(take(), ['gone'], makeContext())).toBeNull();
    expect(enqueueTakeMock).not.toHaveBeenCalled();
  });

  it('writes nothing for a take whose account signed out since the tap', async () => {
    const messaging = await freshMessaging();
    const file = take();
    const arrayBuffer = file.arrayBuffer.bind(file);
    // The sign-out lands while the bytes are being read.
    file.arrayBuffer = async () => {
      signOut.count += 1;
      return arrayBuffer();
    };
    expect(await messaging.sendChatReelTakeTo(file, ['key-g-1'], makeContext())).toBeNull();
    expect(enqueueTakeMock).not.toHaveBeenCalled();
  });

  it('a refused write tells the member and draws no bubble', async () => {
    enqueueTakeMock.mockRejectedValue(new OutboxEnqueueError('no storage layer'));
    const messaging = await freshMessaging();
    const ctx = makeContext();
    expect(await messaging.sendChatReelTakeTo(take(), ['key-g-1', 'key-g-2'], ctx)).toBeNull();
    expect(ctx.setSendError).toHaveBeenCalledWith(m.chat_media_send_error_generic());
    expect(ctx.conversations.get('key-g-1')!.messages).toHaveLength(0);
  });
});
