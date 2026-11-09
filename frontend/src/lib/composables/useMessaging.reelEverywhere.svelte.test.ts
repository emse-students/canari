/**
 * "ANNULER PARTOUT" / "SUPPRIMER PARTOUT" (reels-in-chat 15.2, 15.7): `handleDeleteReelEverywhere`
 * reads the take's reach and ends every message it names - a send still queued withdrawn (its row
 * goes), a send that went deleted for everyone through the one delete path (a tombstone, and the
 * take's record told so the last one releases the file). The reach is a snapshot: a queued send that
 * left the queue since is deleted only if it went out, skipped if it failed. One run per take at a
 * time; a conversation no longer on this device is skipped and counted.
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
const cancelMock = vi.fn();
const settledMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return {
    ...actual,
    outboxReelTakeReachOf: (...args: unknown[]) => reachMock(...args),
    outboxReelSendDeleted: (...args: unknown[]) => sendDeletedMock(...args),
    cancelOutboxMessage: (...args: unknown[]) => cancelMock(...args),
    awaitOutboxSettled: (...args: unknown[]) => settledMock(...args),
    applyOutboxPendingStatuses: async () => {},
  };
});

/** The one delete path for a SENT message: broadcast. */
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
const reach = (queued: number[], standing: number[]) => ({
  takeId: 'take-1',
  queued: queued.map(send),
  standing: standing.map(send),
});

beforeEach(() => {
  reachMock.mockReset();
  sendDeletedMock.mockReset();
  sendDeletedMock.mockResolvedValue(undefined);
  deleteMock.mockReset();
  deleteMock.mockResolvedValue('broadcast');
  cancelMock.mockReset();
  cancelMock.mockResolvedValue(true);
  settledMock.mockReset();
  settledMock.mockResolvedValue('failed');
});

// Each case re-imports the composable (`vi.resetModules`): the first pays the import under a full run.
describe('handleDeleteReelEverywhere', { timeout: 30_000 }, () => {
  it('withdraws the queued sends and deletes the sent ones, each in its own conversation', async () => {
    reachMock.mockResolvedValue(reach([1], [2, 3]));
    const messaging = await freshMessaging();
    const ctx = makeContext();

    expect(await messaging.handleDeleteReelEverywhere('s-2', ctx)).toEqual({
      ended: 3,
      skipped: 0,
      running: false,
    });

    expect(cancelMock.mock.calls.map((c) => c[0])).toEqual(['s-1']);
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual(['s-2', 's-3']);
    // The withdrawn send leaves its thread; the record is told of the two deleted for everyone only.
    expect(ctx.conversations.get('key-g-1')!.messages).toHaveLength(0);
    expect(sendDeletedMock.mock.calls.map((c) => c[0])).toEqual(['s-2', 's-3']);
    expect(ctx.conversations.get('key-g-2')!.messages[0].isDeleted).toBe(true);
    expect(ctx.conversations.get('key-g-3')!.messages[0].isDeleted).toBe(true);
  });

  it('A SNAPSHOT: a queued send that FAILED since is skipped - no delete for an id no peer has', async () => {
    // The press: s-1 and s-2 queued. Since then s-1 failed for good (no longer in the take's reach).
    reachMock.mockImplementation(async (id: string) =>
      id === 's-1' ? reach([2], []) : reach([1, 2], [])
    );
    cancelMock.mockImplementation(async (id: string) => id !== 's-1');
    const messaging = await freshMessaging();
    const ctx = makeContext();

    const run = await messaging.handleDeleteReelEverywhere('s-2', ctx);

    expect(run).toEqual({ ended: 1, skipped: 0, running: false });
    expect(settledMock).toHaveBeenCalledWith('s-1');
    expect(deleteMock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining('left the queue without going out')
    );
  });

  it('A SNAPSHOT: a queued send that WENT since is deleted for everyone', async () => {
    reachMock.mockImplementation(async (id: string) =>
      id === 's-1' ? reach([], [1]) : reach([1], [2])
    );
    cancelMock.mockResolvedValue(false);
    settledMock.mockResolvedValue('sent');
    const messaging = await freshMessaging();
    const ctx = makeContext();

    expect((await messaging.handleDeleteReelEverywhere('s-2', ctx)).ended).toBe(2);
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual(['s-1', 's-2']);
  });

  it('ONE RUN PER TAKE: a second press while the first runs ends nothing', async () => {
    reachMock.mockResolvedValue(reach([], [2, 3]));
    let release!: () => void;
    deleteMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve('broadcast')))
    );
    const messaging = await freshMessaging();
    const ctx = makeContext();

    const first = messaging.handleDeleteReelEverywhere('s-2', ctx);
    await vi.waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(await messaging.handleDeleteReelEverywhere('s-3', ctx)).toEqual({
      ended: 0,
      skipped: 0,
      running: true,
    });
    release();
    expect((await first).ended).toBe(2);
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual(['s-2', 's-3']);
    // Once ended, the take may be asked again (a later press reads a fresh reach).
    expect((await messaging.handleDeleteReelEverywhere('s-2', ctx)).running).toBe(false);
  });

  it('skips and counts a conversation this device no longer holds', async () => {
    reachMock.mockResolvedValue(reach([], [2, 9]));
    const messaging = await freshMessaging();
    const ctx = makeContext();

    expect(await messaging.handleDeleteReelEverywhere('s-2', ctx)).toEqual({
      ended: 1,
      skipped: 1,
      running: false,
    });
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual(['s-2']);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('not on this device - skipped'));
  });

  it('ends nothing for a message no take names', async () => {
    reachMock.mockResolvedValue(null);
    const messaging = await freshMessaging();

    expect(await messaging.handleDeleteReelEverywhere('s-1', makeContext())).toEqual({
      ended: 0,
      skipped: 0,
      running: false,
    });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });
});
