// @vitest-environment happy-dom
/**
 * A DM'S UNREAD COUNT IS DERIVED FROM ITS READ POINT AT EVERY LOAD, NEVER FROM "ARRIVED THIS SESSION".
 *
 * Owner, Android 1.6.9, 2026-11-11: a DM whose last message was never opened showed no badge. The
 * count is not persisted, the read marks are; the load counted only what its replay ADDED, so a
 * message a push had stored at a resume (session 1) was already held at the next cold start
 * (session 2), and counted 0 with nothing read. Each case boots against ONE store that keeps its
 * conversation rows the way both backends do (`localReadSeedStore.test.ts`), the way a phone does
 * across a process death. Map: chat.md, "A DM's unread count is derived from its read point at every
 * load (2026-11-11)".
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { ConversationMeta, StoredMessage } from '$lib/db';
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

// The archive replay brings nothing new unless a case says so: every message is already stored.
const replay = vi.hoisted(() => vi.fn(async (_opts: any) => undefined));
vi.mock('./history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./history')>()),
  replayConversationHistory: replay,
}));

import { loadExistingConversations } from './conversations';
import { mergeFcmMessagesIntoConversations } from './fcmMemoryMerge';

const ME = 'u1';

/**
 * A stored row of `g-1`: the server dated it `at`, its author's phone stamped it `stamp` (by
 * default a little before - a clock that keeps time).
 */
const row = (id: string, senderId: string, at: number, stamp = at - 5): StoredMessage =>
  ({
    id,
    conversationId: 'g-1',
    senderId,
    content: id,
    timestamp: stamp,
    serverTimestamp: at,
  }) as StoredMessage;

/**
 * ONE durable store, shared by every boot. Its conversation row follows the storage contract of
 * `localReadSeed`: a stated value is written, an unstated one keeps the row's, a new row is born 0.
 * `initial.localReadSeed` is what the store migration left on the row.
 */
function durableStore(initial: Partial<ConversationMeta> = {}) {
  const messages: StoredMessage[] = [];
  const rows = new Map<string, ConversationMeta>([
    [
      'g-1',
      {
        id: 'g-1',
        name: 'Equipe',
        lifecycle: 'active',
        updatedAt: 1,
        localReadSeed: 0,
        ...initial,
      },
    ],
  ]);
  return {
    messages,
    rows,
    getConversations: vi.fn(async () => [...rows.values()].map((r) => ({ ...r }))),
    saveConversation: vi.fn(async (conv: ConversationMeta) => {
      const held = rows.get(conv.id);
      const localReadSeed =
        typeof conv.localReadSeed === 'number' ? conv.localReadSeed : held ? held.localReadSeed : 0;
      rows.set(conv.id, { ...conv, localReadSeed });
    }),
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
  opts: {
    service?: ReturnType<typeof mls>;
    conversations?: SvelteMap<string, Conversation>;
    log?: (msg: string) => void;
  } = {}
): Promise<number | undefined> {
  const conversations = opts.conversations ?? new SvelteMap<string, Conversation>();
  await loadExistingConversations({
    storage: store,
    mlsService: opts.service ?? mls(),
    conversations,
    messageReactions: new SvelteMap(),
    userId: ME,
    deviceKeyB64: 'k',
    archivedConversationIds: [],
    historyBaseUrl: '',
    onArchivedIdsChange: vi.fn(),
    log: opts.log ?? vi.fn(),
  } as never);
  return conversations.get('g-1')?.unreadCount;
}

describe('the unread count a load derives', () => {
  let debug: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    replay.mockClear();
    connectivity.reset();
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    debug.mockRestore();
    connectivity.reset();
  });

  it('keeps the badge of a message stored in session 1 and never read, at the next cold start', async () => {
    const store = durableStore();
    // Session 1: the app boots on an empty store, then a resume injects the push cache - the
    // message is stored AND merged live, which counts it.
    const session1 = new SvelteMap<string, Conversation>();
    await coldStart(store, { conversations: session1 });
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

    expect(await coldStart(store, { service })).toBe(1);
    expect(replay).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('with NO read point, counts only what the server holds after my newest own message', async () => {
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000), row('r1', ME, 2_000), row('m2', 'bob', 3_000));

    expect(await coldStart(store)).toBe(1);
  });

  it('decides that on the SERVER clock: my phone running FAST hides no later reply', async () => {
    // I replied at server 2000 from a phone an hour ahead; the peer answered at server 3000.
    const store = durableStore();
    store.messages.push(row('r1', ME, 2_000, 3_602_000), row('m2', 'bob', 3_000));

    expect(await coldStart(store)).toBe(1);
  });

  it('decides that on the SERVER clock: my phone running SLOW counts no earlier message', async () => {
    // The peer wrote at server 1500; I replied after it, at server 2000, from a phone an hour behind.
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_500), row('r1', ME, 2_000, 2_000 - 3_600_000));

    expect(await coldStart(store)).toBe(0);
  });

  it('with no read point and no own message (a first contact on this install), counts every message', async () => {
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

  it.each(['removed', 'pending'] as const)(
    'gives a %s row no badge: it takes no read mark, so nothing could ever clear one',
    async (lifecycle) => {
      const store = durableStore({ lifecycle });
      store.messages.push(row('m1', 'bob', 1_000));

      expect(await coldStart(store)).toBe(0);
    }
  );

  it('on a SLOW link, shows the badge of what is held before the replay answers', async () => {
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000));
    const conversations = new SvelteMap<string, Conversation>();
    let release!: () => void;
    let badgeWhileReplaying: number | undefined;
    replay.mockImplementationOnce(async () => {
      // The replay is in flight, and the link is slow: the badge is already there.
      badgeWhileReplaying = conversations.get('g-1')?.unreadCount;
      await new Promise<void>((resolve) => (release = resolve));
      return undefined;
    });

    const loading = coldStart(store, { conversations });
    await vi.waitFor(() => expect(badgeWhileReplaying).toBe(1));
    release();
    expect(await loading).toBe(1);
  });

  it('after the stored page, only a MARK the replay brings lowers the badge; what it adds raises it', async () => {
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000));
    replay.mockImplementationOnce(async () => {
      store.messages.push(row('m2', 'bob', 2_000));
      return undefined;
    });
    expect(await coldStart(store)).toBe(2);
  });

  it('logs, at debug, a row that left the map before its count, and publishes nothing for it', async () => {
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000));
    const conversations = new SvelteMap<string, Conversation>();
    // The stored page read is where the row is lost (a leave or an account switch meanwhile).
    store.getMessagesPage.mockImplementationOnce(async () => {
      conversations.delete('g-1');
      return [];
    });

    await coldStart(store, { conversations });

    expect(conversations.has('g-1')).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('left the conversation map before its count (stored page)')
    );
  });

  it('a mark the replay brings lowers the stored page`s badge, and the census says the last count', async () => {
    const store = durableStore();
    store.messages.push(row('m1', 'bob', 1_000));
    // The replay learns that m1 was read on another device.
    replay.mockImplementationOnce(async (opts: any) => {
      const c = opts.getConversation('g-1');
      opts.setConversation('g-1', { ...c, serverReadWatermarks: { [ME]: 1_000 } });
      return undefined;
    });
    const conversations = new SvelteMap<string, Conversation>();
    const seen: number[] = [];
    const set = conversations.set.bind(conversations);
    conversations.set = (key: string, value: Conversation) => {
      if (key === 'g-1' && value.unreadCount !== undefined) seen.push(value.unreadCount);
      return set(key, value);
    };

    const log = vi.fn();
    await coldStart(store, { conversations, log });

    // 1 at the stored page, 0 once the replay brought the mark - never a rise after a fall.
    // Each value set, consecutive repeats dropped (the replay writes the row as it found it).
    expect(seen.filter((count, i) => i === 0 || count !== seen[i - 1])).toEqual([0, 1, 0]);
    expect(conversations.get('g-1')?.unreadCount).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "[RESTORE] unread census: 0 conversation(s) counted from the upgrade's local read seed, 0 with a badge, 0 unread in all"
    );
  });
});

/**
 * The seed is written by the STORE MIGRATION (`localReadSeedStore.test.ts` pins the SQL and the
 * versionchange walk); here the store hands it over as the migration left it, and the restore only
 * READS it.
 */
describe("the upgrade's local read seed, read by the restore", () => {
  let debug: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    replay.mockReset();
    replay.mockImplementation(async () => undefined);
    connectivity.reset();
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => debug.mockRestore());

  it('lights nothing at the upgrade: what the row held at the migration is read', async () => {
    // A group I lurk in: no read point, a page of foreign messages, seeded at its newest by the migration.
    const store = durableStore({ localReadSeed: 2_000 });
    store.messages.push(row('m1', 'bob', 1_000), row('m2', 'carol', 2_000));
    const log = vi.fn();

    expect(await coldStart(store, { log })).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "[RESTORE] unread census: 1 conversation(s) counted from the upgrade's local read seed, 0 with a badge, 0 unread in all"
    );
  });

  it('only READS it: the restore writes no seed, moves no read mark and sends nothing', async () => {
    const store = durableStore({ localReadSeed: 1_000 });
    store.messages.push(row('m1', 'bob', 1_000));
    const sends = {
      sendReadWatermark: vi.fn(async () => {}),
      enqueueControlEvent: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
    };
    const conversations = new SvelteMap<string, Conversation>();

    await coldStart(store, { service: mls(sends), conversations });

    for (const call of store.saveConversation.mock.calls) {
      expect((call as unknown as [ConversationMeta])[0].localReadSeed ?? 1_000).toBe(1_000);
    }
    const saved = store.rows.get('g-1');
    expect(saved?.localReadSeed).toBe(1_000);
    expect(saved?.readWatermarks).toBeUndefined();
    expect(saved?.serverReadWatermarks).toBeUndefined();
    expect(conversations.get('g-1')?.serverReadWatermarks).toBeUndefined();
    expect(sends.sendReadWatermark).not.toHaveBeenCalled();
    expect(sends.enqueueControlEvent).not.toHaveBeenCalled();
    expect(sends.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['before the restore', 'before'],
    ['at the boot pull (the rows-seeded seam)', 'pull'],
    ['during the replay', 'replay'],
    ['after the load, through the push cache', 'after'],
  ] as const)(
    'counts a message the push-cache path stores %s: the seed never covers it',
    async (_label, when) => {
      const store = durableStore({ localReadSeed: 1_000 });
      store.messages.push(row('m1', 'bob', 1_000));
      const late = row('k1', 'bob', 5_000);
      if (when === 'before') store.messages.push(late);
      if (when === 'replay') {
        replay.mockImplementationOnce(async () => {
          store.messages.push(late);
          return undefined;
        });
      }
      const service = mls({
        notifyConversationRowsSeeded: vi.fn(() => {
          if (when === 'pull') store.messages.push(late);
        }),
      });
      const conversations = new SvelteMap<string, Conversation>();

      await coldStart(store, { service, conversations });
      if (when === 'after') {
        store.messages.push(late);
        mergeFcmMessagesIntoConversations([late], conversations, ME);
        expect(conversations.get('g-1')?.unreadCount).toBe(1);
      }

      // Whatever the session saw, the next cold start derives it from the store.
      expect(await coldStart(store)).toBe(1);
      expect(store.rows.get('g-1')?.localReadSeed).toBe(1_000);
    }
  );

  it('a saved mark below the seed un-hides nothing; past both, a message counts', async () => {
    const store = durableStore({ localReadSeed: 2_000, serverReadWatermarks: { [ME]: 1_000 } });
    store.messages.push(row('m1', 'bob', 1_000), row('m2', 'bob', 2_000));
    expect(await coldStart(store)).toBe(0);

    store.messages.push(row('m3', 'bob', 3_000));
    expect(await coldStart(store)).toBe(1);
  });

  it('an EMPTY row is seeded 0 by the migration: what is replayed into it after counts', async () => {
    const store = durableStore({ localReadSeed: 0 });
    replay.mockImplementationOnce(async () => {
      store.messages.push(row('old', 'bob', 1_500), row('new', 'bob', 3_000));
      return undefined;
    });

    await coldStart(store);
    expect(await coldStart(store)).toBe(2);
  });
});
