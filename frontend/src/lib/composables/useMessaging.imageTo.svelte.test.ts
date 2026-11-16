/**
 * A PHOTO FROM THE CAMERA TAB'S "Envoyer a..." (D-photo, owner 2026-11-16, reels-in-chat section
 * 22): `sendImageTo` prepares it once and sends it to every chosen conversation as an ORDINARY image
 * message through the composer's own path - one bubble and one durable outbox entry per
 * conversation, a conversation this device does not hold skipped, the staging never touched, and
 * nothing sent after a sign-out.
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

vi.mock('$lib/utils/chat/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/outbox')>()),
  enqueueOutboxMessage: async () => {},
  applyOutboxPendingStatuses: async () => {},
}));

// The server's ceiling is not asked in a unit test: `null` refuses nothing here.
vi.mock('$lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/media')>();
  class MediaService extends actual.MediaService {
    override async uploadLimits() {
      return null;
    }
  }
  // No decoder in a unit test: the picture's size is given.
  return { ...actual, MediaService, readImageDimensions: async () => ({ width: 4, height: 4 }) };
});
vi.mock('$lib/utils/mediaPlaceholder', () => ({ placeholderForImageFile: async () => null }));

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { OutboxEntry, StoredMessage } from '$lib/db';

function convo(key: string): [string, Conversation] {
  return [
    key,
    {
      id: key,
      name: key,
      messages: [],
      unreadCount: 0,
      lastMessageAt: 0,
      lifecycle: 'active',
    } as never,
  ];
}

function makeContext(entries: OutboxEntry[]) {
  const saveMessage = vi.fn().mockResolvedValue(undefined);
  return {
    conversations: new SvelteMap<string, Conversation>([convo('dm-a'), convo('group-b')]),
    userId: 'me',
    // The member is looking at ANOTHER conversation: the sends must not need it selected.
    selectedContact: 'elsewhere',
    selectedNow: () => 'elsewhere',
    setSendError: vi.fn(),
    log: vi.fn(),
    ensureMls: vi.fn(() => {
      throw new Error('the send path asked the MLS service');
    }),
    deviceKeyB64: 'device-key',
    saveConversation: vi.fn().mockResolvedValue(undefined),
    storage: {
      saveMessage,
      saveMessagesIfAbsent: vi.fn(async (rows: StoredMessage[], key: string) => {
        for (const row of rows) await saveMessage(row, key);
        return new Set(rows.map((row) => row.id));
      }),
      getMessagesByIds: vi.fn(async () => ({ rows: new Map(), unreadable: new Set() })),
      getPendingMutations: vi.fn(async () => ({ entries: [], unreadable: 0 })),
      saveMessageWithOutboxEntry: vi.fn(async (_row: StoredMessage, e: OutboxEntry) => {
        entries.push(e);
      }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as MessagingContext;
}

/** A GIF: sent as-is (never re-encoded), so no canvas is needed here. */
const photo = () => new File(['GIF89a'], 'canari-photo.gif', { type: 'image/gif' });

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

beforeEach(() => {
  signOut.count = 0;
});

describe('sendImageTo (D-photo)', () => {
  it('sends one ordinary image message per held conversation, and skips one this device does not hold', async () => {
    const messaging = await freshMessaging();
    const entries: OutboxEntry[] = [];
    const ctx = makeContext(entries);
    const handed = await messaging.sendImageTo(photo(), ['dm-a', 'gone', 'group-b', 'dm-a'], ctx);
    expect(handed).toBe(2);
    expect(entries.map((e) => [e.kind, e.conversationId])).toEqual([
      ['media', 'dm-a'],
      ['media', 'group-b'],
    ]);
    // Nothing was staged in either composer, nor in the one on screen.
    for (const key of ['dm-a', 'group-b', 'elsewhere']) {
      expect(messaging.pendingMediaFilesFor(key)).toEqual([]);
    }
  });

  it('answers null and sends nothing when no chosen conversation is held', async () => {
    const messaging = await freshMessaging();
    const entries: OutboxEntry[] = [];
    expect(await messaging.sendImageTo(photo(), ['gone'], makeContext(entries))).toBeNull();
    expect(entries).toEqual([]);
  });

  it('sends nothing after a sign-out that came in during the preparation', async () => {
    const messaging = await freshMessaging();
    const entries: OutboxEntry[] = [];
    const ctx = makeContext(entries);
    const pending = messaging.sendImageTo(photo(), ['dm-a', 'group-b'], ctx);
    signOut.count += 1;
    expect(await pending).toBeNull();
    expect(entries).toEqual([]);
  });
});
