// @vitest-environment happy-dom
/**
 * THE USER'S OWN ACT ON A MESSAGE SHOWN WITH NO ROW UNDER ITS CONVERSATION IS KEPT, NOT LOST (review
 * of #3406). A re-keyed 1:1 is shown under the joined group while its stored history still moves
 * there from the old group: a reaction, an edit or a delete made in that window found no row, was
 * written nowhere, and a reload brought the old state back. It is now kept as a pending mutation and
 * settled by the move's own look (`settlePendingFor`), as a peer's act is. Ids are fixed fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const outboxMock = vi.hoisted(() => ({
  cancelOutboxMessage: vi.fn(async () => false),
  enqueueOutboxMessage: vi.fn(async (_entry: unknown, _opts?: unknown) => {}),
}));
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/outbox')>()),
  ...outboxMock,
}));

import { moveDirectConversationRows } from '$lib/utils/chat/conversations';
import { settlePendingFor } from '$lib/utils/chat/pendingMutationStore';
import {
  messageRowStore,
  placement,
  storedRow,
} from '$lib/mls-client/test/fixtures/messageRowStore';
import type { Conversation, MessageReaction } from '$lib/types';
import type { IStorage } from '$lib/db';

type MessagingContext = import('./useMessaging.svelte').MessagingContext;

const OLD = 'old-group';
const JOINED = 'joined-group';
const body = (text: string) => JSON.stringify({ kind: 'text', text });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('an own act on a message whose row is still moving', () => {
  it('a reaction, an edit and a delete are kept, then carried by the moved rows', async () => {
    const store = messageRowStore([
      storedRow('m1', OLD, { senderId: 'me', content: body('hello') }),
      storedRow('m2', OLD, { senderId: 'me', content: body('to delete') }),
    ]);
    // The joined group is shown, its history not moved yet.
    const conversations = new SvelteMap<string, Conversation>([
      [
        JOINED,
        {
          id: JOINED,
          name: JOINED,
          unreadCount: 0,
          lastMessageAt: 0,
          messages: [
            { id: 'm1', senderId: 'me', content: body('hello'), timestamp: new Date(1000) },
            { id: 'm2', senderId: 'me', content: body('to delete'), timestamp: new Date(1000) },
          ],
        } as never,
      ],
    ]);
    const log = vi.fn();
    const ctx = {
      conversations,
      selectedContact: JOINED,
      userId: 'me',
      deviceKeyB64: 'k',
      storage: store,
      log,
      ensureMls: () => ({}),
    } as unknown as MessagingContext;
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();

    await messaging.handleAddReaction('m1', 'x', ctx);
    await messaging.handleEditMessage('m1', 'edited', ctx);
    await messaging.handleDeleteMessage('m2', ctx);

    // Written nowhere yet: no row under the joined group. Kept instead.
    expect(placement(store)).toEqual({ m1: OLD, m2: OLD });
    expect(store.pending.size).toBe(3);

    // The move, then its look - what the Welcome's re-key does.
    const { moved } = await moveDirectConversationRows(
      OLD,
      JOINED,
      store as unknown as IStorage,
      'k'
    );
    await settlePendingFor(
      {
        storage: store as unknown as IStorage,
        deviceKey: () => 'k',
        conversations,
        messageReactions: new SvelteMap<string, MessageReaction[]>(),
        log,
      },
      JOINED,
      moved
    );

    expect(placement(store)).toEqual({ m1: JOINED, m2: JOINED });
    expect(store.byId.get('m1')?.content).toContain('edited');
    expect(store.byId.get('m1')?.isEdited).toBe(true);
    expect(store.byId.get('m1')?.reactions?.map((r) => r.emoji)).toEqual(['x']);
    expect(store.byId.get('m2')?.isDeleted).toBe(true);
    expect(store.pending.size).toBe(0);
  });

  it('control: a message whose row stands is written in place and keeps nothing', async () => {
    const store = messageRowStore([
      storedRow('m1', JOINED, { senderId: 'me', content: body('hi') }),
    ]);
    const conversations = new SvelteMap<string, Conversation>([
      [
        JOINED,
        {
          id: JOINED,
          name: JOINED,
          unreadCount: 0,
          lastMessageAt: 0,
          messages: [{ id: 'm1', senderId: 'me', content: body('hi'), timestamp: new Date(1000) }],
        } as never,
      ],
    ]);
    const ctx = {
      conversations,
      selectedContact: JOINED,
      userId: 'me',
      deviceKeyB64: 'k',
      storage: store,
      log: vi.fn(),
      ensureMls: () => ({}),
    } as unknown as MessagingContext;
    const { useMessaging } = await import('./useMessaging.svelte');
    await useMessaging().handleAddReaction('m1', 'x', ctx);

    expect(store.byId.get('m1')?.reactions?.map((r) => r.emoji)).toEqual(['x']);
    expect(store.pending.size).toBe(0);
  });

  it('a shown key in another case writes the row of the lowercased conversation, keeping nothing', async () => {
    const store = messageRowStore([
      storedRow('m1', JOINED, { senderId: 'me', content: body('hello') }),
      storedRow('m2', JOINED, { senderId: 'me', content: body('to delete') }),
    ]);
    // The edit and delete paths hand the shown key as the map holds it.
    const shown = JOINED.toUpperCase();
    const conversations = new SvelteMap<string, Conversation>([
      [
        shown,
        {
          id: JOINED,
          name: JOINED,
          unreadCount: 0,
          lastMessageAt: 0,
          messages: [
            { id: 'm1', senderId: 'me', content: body('hello'), timestamp: new Date(1000) },
            { id: 'm2', senderId: 'me', content: body('to delete'), timestamp: new Date(1000) },
          ],
        } as never,
      ],
    ]);
    const ctx = {
      conversations,
      selectedContact: shown,
      userId: 'me',
      deviceKeyB64: 'k',
      storage: store,
      log: vi.fn(),
      ensureMls: () => ({}),
    } as unknown as MessagingContext;
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();

    await messaging.handleEditMessage('m1', 'edited', ctx);
    await messaging.handleDeleteMessage('m2', ctx);

    expect(store.byId.get('m1')?.content).toContain('edited');
    expect(store.byId.get('m2')?.isDeleted).toBe(true);
    expect(store.pending.size).toBe(0);
  });

  it.each([
    ['left under the old group by the move', OLD],
    ['sealed under the shown conversation', JOINED],
  ])('a row that stands and does not open (%s) keeps nothing, and says why', async (_c, conv) => {
    const store = messageRowStore([
      storedRow('m1', conv, { senderId: 'me', content: body('hi'), unreadable: true }),
    ]);
    const conversations = new SvelteMap<string, Conversation>([
      [
        JOINED,
        {
          id: JOINED,
          name: JOINED,
          unreadCount: 0,
          lastMessageAt: 0,
          messages: [{ id: 'm1', senderId: 'me', content: body('hi'), timestamp: new Date(1000) }],
        } as never,
      ],
    ]);
    const log = vi.fn();
    const ctx = {
      conversations,
      selectedContact: JOINED,
      userId: 'me',
      deviceKeyB64: 'k',
      storage: store,
      log,
      ensureMls: () => ({}),
    } as unknown as MessagingContext;
    const { useMessaging } = await import('./useMessaging.svelte');
    await useMessaging().handleAddReaction('m1', 'x', ctx);

    expect(store.pending.size).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('cannot open it'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('not stored yet') || l.includes('kept until'))).toBe(false);
  });
});
