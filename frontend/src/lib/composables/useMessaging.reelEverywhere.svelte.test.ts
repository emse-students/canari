/**
 * "ANNULER PARTOUT" / "SUPPRIMER PARTOUT" (reels-in-chat 15.2, 15.7): `handleDeleteReelEverywhere`
 * reads the take's reach ONCE and ends every message it names through the one delete path - a send
 * still queued withdrawn (its row goes), a send that went deleted for everyone (a tombstone, and the
 * take's record told so the last one releases the file). A conversation no longer on this device is
 * skipped; a message no take names ends nothing.
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

const reachMock = vi.fn();
const sendDeletedMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return {
    ...actual,
    outboxReelTakeReachOf: (...args: unknown[]) => reachMock(...args),
    outboxReelSendDeleted: (...args: unknown[]) => sendDeletedMock(...args),
    applyOutboxPendingStatuses: async () => {},
  };
});

/** The one delete path: a queued send is withdrawn, a sent one broadcast. */
const deleteMock = vi.fn();
vi.mock('$lib/utils/chat/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/messaging')>();
  return { ...actual, deleteMessage: (...args: unknown[]) => deleteMock(...args) };
});

import type { ChatMessage, Conversation } from '$lib/types';

type MessagingContext = import('./useMessaging.svelte').MessagingContext;

function message(id: string): ChatMessage {
  return { id, senderId: 'me', content: '', timestamp: 1, isOwn: true } as never;
}

function convo(id: string, messageIds: string[]): [string, Conversation] {
  return [
    `key-${id}`,
    {
      id,
      name: id,
      messages: messageIds.map(message),
      unreadCount: 0,
      lastMessageAt: 0,
      lifecycle: 'active',
    } as never,
  ];
}

function makeContext() {
  return {
    conversations: new SvelteMap<string, Conversation>([
      convo('g-1', ['s-1']),
      convo('g-2', ['s-2']),
      convo('g-3', ['s-3']),
    ]),
    userId: 'me',
    selectedContact: 'key-g-1',
    selectedNow: () => 'key-g-1',
    setSendError: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    storage: null,
    ensureMls: vi.fn(() => ({})),
  } as unknown as MessagingContext;
}

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

const send = (n: number) => ({ id: `s-${n}`, conversationId: `g-${n}` });

beforeEach(() => {
  reachMock.mockReset();
  sendDeletedMock.mockReset();
  sendDeletedMock.mockResolvedValue(undefined);
  deleteMock.mockReset();
});

describe('handleDeleteReelEverywhere', () => {
  it('withdraws the queued sends and deletes the sent ones, each in its own conversation', async () => {
    reachMock.mockResolvedValue({ queued: [send(1)], standing: [send(2), send(3)] });
    deleteMock.mockImplementation(async (id: string) => (id === 's-1' ? 'withdrawn' : 'broadcast'));
    const messaging = await freshMessaging();
    const ctx = makeContext();

    expect(await messaging.handleDeleteReelEverywhere('s-2', ctx)).toBe(3);

    expect(reachMock).toHaveBeenCalledTimes(1);
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual(['s-1', 's-2', 's-3']);
    // The withdrawn send leaves its thread; the record is told of the two deleted for everyone only.
    expect(ctx.conversations.get('key-g-1')!.messages).toHaveLength(0);
    expect(sendDeletedMock.mock.calls.map((c) => c[0])).toEqual(['s-2', 's-3']);
    expect(ctx.conversations.get('key-g-2')!.messages[0].isDeleted).toBe(true);
    expect(ctx.conversations.get('key-g-3')!.messages[0].isDeleted).toBe(true);
  });

  it('skips a conversation this device no longer holds, and says so', async () => {
    reachMock.mockResolvedValue({ queued: [], standing: [send(2), send(9)] });
    deleteMock.mockResolvedValue('broadcast');
    const messaging = await freshMessaging();
    const ctx = makeContext();

    expect(await messaging.handleDeleteReelEverywhere('s-2', ctx)).toBe(1);
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual(['s-2']);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('not on this device - skipped'));
  });

  it('ends nothing for a message no take names', async () => {
    reachMock.mockResolvedValue(null);
    const messaging = await freshMessaging();

    expect(await messaging.handleDeleteReelEverywhere('s-1', makeContext())).toBe(0);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
