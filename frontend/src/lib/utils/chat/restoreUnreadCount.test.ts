// @vitest-environment happy-dom
/**
 * A DM'S UNREAD COUNT IS DERIVED FROM ITS READ POINT AT EVERY LOAD, NEVER FROM "ARRIVED THIS SESSION".
 *
 * Owner, Android 1.6.9, 2026-11-11: a DM whose last message was never opened showed no badge. The
 * count is not persisted, the read marks are; the load counted only what its replay ADDED, so a
 * message a push had stored at a resume (session 1) was already held at the next cold start
 * (session 2), and counted 0 with nothing read. Each case below boots twice against ONE store, the
 * way a phone does across a process death. Map: chat.md, "A DM's unread count is derived from its
 * read point at every load (2026-11-11)".
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { StoredMessage } from '$lib/db';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { connectivity } from '$lib/stores/connectivity.svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

// The archive replay brings nothing new: every message below is already in the store.
const replay = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./history')>()),
  replayConversationHistory: replay,
}));

import { loadExistingConversations } from './conversations';
import { mergeFcmMessagesIntoConversations } from './fcmMemoryMerge';

const ME = 'u1';

/** A stored row of `g-1`, dated by the server at `at` (its author's stamp a little before). */
const row = (id: string, senderId: string, at: number): StoredMessage =>
  ({
    id,
    conversationId: 'g-1',
    senderId,
    content: id,
    timestamp: at - 5,
    serverTimestamp: at,
  }) as StoredMessage;

/** ONE durable store, shared by every boot: what survives the process. */
function durableStore(meta: Record<string, unknown> = {}) {
  const messages: StoredMessage[] = [];
  return {
    messages,
    getConversations: vi.fn(async () => [
      { id: 'g-1', name: 'Equipe', lifecycle: 'active', ...meta },
    ]),
    saveConversation: vi.fn(async () => {}),
    getMessagesPage: vi.fn(async (id: string) => messages.filter((m) => m.conversationId === id)),
    deleteMessagesForConversation: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => {}),
  };
}

function mls(overrides: Record<string, unknown> = {}) {
  return {
    getLocalGroups: vi.fn(() => []),
    getUserGroups: vi.fn(async () => []),
    fetchHistoryBatch: vi.fn(async () => new Map()),
    notifyConversationsRestored: vi.fn(),
    notifyConversationRowsSeeded: vi.fn(),
    beginBulkIngest: vi.fn(),
    endBulkIngest: vi.fn(),
    persistCheckpoint: vi.fn(async () => {}),
    isDistributionGroup: vi.fn(() => false),
    getDismissedGroups: vi.fn(async () => ({ kind: 'listed' as const, groupIds: [] })),
    ...overrides,
  };
}

/** One cold start: a fresh in-memory map, the same store. Returns the badge of `g-1`. */
async function coldStart(
  store: ReturnType<typeof durableStore>,
  service = mls(),
  conversations = new SvelteMap<string, Conversation>()
): Promise<number | undefined> {
  await loadExistingConversations({
    storage: store,
    mlsService: service,
    conversations,
    messageReactions: new SvelteMap(),
    userId: ME,
    deviceKeyB64: 'k',
    archivedConversationIds: [],
    historyBaseUrl: '',
    onArchivedIdsChange: vi.fn(),
    log: vi.fn(),
  } as never);
  return conversations.get('g-1')?.unreadCount;
}

describe('the unread count a load derives', () => {
  beforeEach(() => {
    replay.mockClear();
    connectivity.reset();
  });
  afterEach(() => connectivity.reset());

  it('keeps the badge of a message stored in session 1 and never read, at the next cold start', async () => {
    const store = durableStore();
    // Session 1: the app boots on an empty store, then a resume injects the push cache - the
    // message is stored AND merged live, which counts it.
    const session1 = new SvelteMap<string, Conversation>();
    await coldStart(store, mls(), session1);
    const pushed = row('m1', 'bob', 1_000);
    store.messages.push(pushed);
    mergeFcmMessagesIntoConversations([pushed], session1, ME);
    expect(session1.get('g-1')?.unreadCount).toBe(1);

    // The process dies. Session 2 finds the message already held: it is still unread.
    expect(await coldStart(store)).toBe(1);
    // And session 3, and every one after, until it is read.
    expect(await coldStart(store)).toBe(1);
  });

  it('counts at the saved read point: what it covers is read, what lies past it is not', async () => {
    const store = durableStore({ serverReadWatermarks: { [ME]: 1_000 } });
    store.messages.push(row('m1', 'bob', 1_000), row('m2', 'bob', 2_000));

    expect(await coldStart(store)).toBe(1);
  });

  it('counts the same with no link at all (the replay is skipped, the stored page is not)', async () => {
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000));
    const service = mls({
      fetchHistoryBatch: vi.fn(async () => {
        connectivity.notifyServerUnreachable();
        throw new TransportFailureError(new TypeError('Failed to fetch'));
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await coldStart(store, service)).toBe(1);
    expect(replay).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('with NO saved read point, counts only what came after my newest own message', async () => {
    // A conversation read before read state was durable: I replied at 2000, so 1000 was on screen.
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000), row('r1', ME, 2_000), row('m2', 'bob', 3_000));

    expect(await coldStart(store)).toBe(1);
  });

  it('with no read point and no own message (a first contact never opened), counts every message', async () => {
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000), row('m2', 'bob', 2_000));

    expect(await coldStart(store)).toBe(2);
  });

  it('never counts my own messages or a system notice', async () => {
    const store = durableStore();
    store.messages.push(row('r1', ME, 1_000), row('n1', 'system', 2_000));

    expect(await coldStart(store)).toBe(0);
  });

  it('does not count history a bundle restored when its read state covers it', async () => {
    // A new device: the bundle brought both messages AND the mark read on the other device, which
    // the bundle handler persisted on the conversation (step 0 of `history_bundle`).
    const store = durableStore({ serverReadWatermarks: { [ME]: 2_000 } });
    store.messages.push(row('m1', 'bob', 1_000), row('m2', 'bob', 2_000));

    expect(await coldStart(store)).toBe(0);
  });
});
