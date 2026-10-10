/**
 * A QUEUED ATTACHMENT LEAVES NO ORPHAN BEHIND WHEN THE QUEUE CANNOT TAKE IT (Mi 9T, alpha.3).
 *
 * `handleSendChat` writes a `mediaId: ''` placeholder, then the outbox entry. A placeholder with no
 * entry is a bubble nothing will ever upload, and a second Send on the re-staged file duplicates it.
 * So the file is read BEFORE the placeholder, and a refused enqueue withdraws the placeholder.
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

const enqueueMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return { ...actual, enqueueOutboxMessage: (...args: unknown[]) => enqueueMock(...args) };
});

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { PendingMediaFile } from '$lib/media';

const CONVO = 'conversation-key';

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
        lifecycle: 'active',
      } as never,
    ],
  ]);
  return {
    conversations,
    userId: 'me',
    selectedContact: CONVO,
    setSendError: vi.fn(),
    log: vi.fn(),
    ensureMls: () => ({ waitForMessageQueueIdle: async () => {} }),
    verifyCurrentUserMembership: async () => true,
  } as unknown as MessagingContext;
}

const entryOf = (arrayBuffer: () => Promise<ArrayBuffer>): PendingMediaFile =>
  ({
    file: { name: 'a.pdf', type: 'application/pdf', size: 3, arrayBuffer },
    width: undefined,
    height: undefined,
  }) as unknown as PendingMediaFile;

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

describe('an attachment the queue cannot take', () => {
  beforeEach(() => enqueueMock.mockReset());

  it('a file that cannot be read writes no placeholder and is re-staged', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const file = entryOf(async () => {
      throw new DOMException('gone', 'NotReadableError');
    });
    await messaging.handleSendChat(ctx, '', { files: [file] });
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(messaging.pendingMediaFiles).toEqual([file]);
  });

  it('a refused enqueue withdraws the placeholder before the file is re-staged', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const { OutboxEnqueueError } = await import('$lib/utils/chat/outbox');
    enqueueMock.mockImplementation(async (entry?: { kind: string }) => {
      if (entry?.kind !== 'media') return;
      throw new OutboxEnqueueError('the durable write failed');
    });
    const file = entryOf(async () => new ArrayBuffer(3));
    await messaging.handleSendChat(ctx, '', { files: [file] });
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(0);
    expect(messaging.pendingMediaFiles).toEqual([file]);
  });

  it('a queued attachment keeps its placeholder', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    enqueueMock.mockResolvedValue(undefined);
    await messaging.handleSendChat(ctx, '', {
      files: [entryOf(async () => new ArrayBuffer(3))],
    });
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
  });
});
