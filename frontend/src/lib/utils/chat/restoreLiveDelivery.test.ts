// @vitest-environment happy-dom
/**
 * A LIVE DELIVERY DURING THE RESTORE'S SECOND PHASE SURVIVES IT.
 *
 * The restore asks the service to re-fetch the frames it refused for lack of a row as soon as the
 * rows exist (`notifyConversationRowsSeeded`), which is what lets the message a notification opened
 * the app for render before every conversation's history has been replayed - ~1.2 s sooner on the
 * bench phone. That is only safe if nothing the second phase writes afterwards REPLACES a row a live
 * delivery has written meanwhile. Two writes did: the stored page was ASSIGNED over `messages`, and
 * the DM repair spread a copy of the row read before an await. These cases put a live message on the
 * row at exactly those two seams and assert it is still there at the end.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation, ChatMessage } from '$lib/types';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

import { loadExistingConversations } from './conversations';

/** What a live delivery puts on the row: newer than anything stored. */
const LIVE: ChatMessage = {
  id: 'live-1',
  senderId: 'bob',
  content: 'notified message',
  timestamp: new Date(10_000),
} as ChatMessage;

/** One stored message, older than the live one, in the shape `getMessagesPage` returns. */
const STORED = {
  id: 'stored-1',
  conversationId: 'g-1',
  senderId: 'bob',
  content: 'from yesterday',
  timestamp: 1_000,
};

/** Puts the live message on the row, the way `batchAddMessages` would after a drain. */
function deliverLive(conversations: SvelteMap<string, Conversation>, id: string): void {
  const row = conversations.get(id);
  if (!row) throw new Error(`no row for ${id} - the live delivery would have been refused`);
  conversations.set(id, { ...row, messages: [...row.messages, LIVE] });
}

function mls(overrides: Record<string, unknown> = {}) {
  return {
    getLocalGroups: vi.fn(() => []),
    getUserGroups: vi.fn(async () => []),
    notifyConversationsRestored: vi.fn(),
    notifyConversationRowsSeeded: vi.fn(),
    beginBulkIngest: vi.fn(),
    endBulkIngest: vi.fn(),
    persistCheckpoint: vi.fn(async () => {}),
    isDistributionGroup: vi.fn(() => false),
    getDismissedGroups: vi.fn(async () => []),
    ...overrides,
  };
}

function storage(overrides: Record<string, unknown> = {}) {
  return {
    getConversations: vi.fn(async () => [{ id: 'g-1', name: 'Equipe', lifecycle: 'active' }]),
    saveConversation: vi.fn(async () => {}),
    getMessagesPage: vi.fn(async () => []),
    deleteMessagesForConversation: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => {}),
    ...overrides,
  };
}

function restore(
  conversations: SvelteMap<string, Conversation>,
  mlsService: ReturnType<typeof mls>,
  store: ReturnType<typeof storage>,
  log: (msg: string) => void = vi.fn()
) {
  return loadExistingConversations({
    storage: store,
    mlsService,
    conversations,
    messageReactions: new SvelteMap(),
    userId: 'u1',
    deviceKeyB64: 'k',
    archivedConversationIds: [],
    historyBaseUrl: '',
    onArchivedIdsChange: vi.fn(),
    log,
  } as never);
}

describe('the restore and a live delivery', () => {
  it('asks for the frames left behind once, when every row exists and before any history is read', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const order: string[] = [];
    const service = mls({
      notifyConversationRowsSeeded: vi.fn(() => {
        order.push(`seeded:${[...conversations.keys()].join(',')}`);
      }),
      getUserGroups: vi.fn(async () => {
        order.push('phase2');
        return [];
      }),
    });
    const store = storage({
      getMessagesPage: vi.fn(async () => {
        order.push('page');
        return [];
      }),
    });
    const log = vi.fn();

    await restore(conversations, service, store, log);

    expect(service.notifyConversationRowsSeeded).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('seeded:g-1');
    expect(order.indexOf('seeded:g-1')).toBeLessThan(order.indexOf('phase2'));
    expect(log).toHaveBeenCalledWith('[RESTORE] 1 conversation row(s) seeded - history follows');
  });

  it('starts its history phase only once the catch-up the rows released has drained', async () => {
    // The login's pull is held until the rows exist and returned by `notifyConversationRowsSeeded`
    // (iPhone 12, 2026-11-01). Not awaited, phase 2's first barrier pulled the mailbox itself.
    const conversations = new SvelteMap<string, Conversation>();
    const order: string[] = [];
    let drain!: () => void;
    const service = mls({
      notifyConversationRowsSeeded: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push('catch-up');
            drain = () => {
              order.push('drained');
              resolve();
            };
          })
      ),
      getUserGroups: vi.fn(async () => {
        order.push('phase2');
        return [];
      }),
    });
    const running = restore(conversations, service, storage());
    await vi.waitFor(() => expect(order).toEqual(['catch-up']));
    drain();
    await running;
    expect(order.slice(0, 3)).toEqual(['catch-up', 'drained', 'phase2']);
  });

  it('merges the stored page into a row a live delivery wrote after the rows were seeded', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    let reads = 0;
    const store = storage({
      getMessagesPage: vi.fn(async () => {
        reads += 1;
        // The first read is the stored page; the live frame landed while it was being read.
        if (reads === 1) deliverLive(conversations, 'g-1');
        return [STORED];
      }),
    });

    await restore(conversations, mls(), store);

    expect(conversations.get('g-1')?.messages.map((m) => m.id)).toEqual(['stored-1', 'live-1']);
  });

  it('keeps a live message delivered while the DM repair was asking the roster', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const service = mls({
      getUserGroups: vi.fn(async () => [{ groupId: 'g-1', isGroup: false, name: 'Equipe' }]),
      getGroupUserMembers: vi.fn(async () => {
        deliverLive(conversations, 'g-1');
        return [{ userId: 'u1' }, { userId: 'bob' }];
      }),
    });

    await restore(conversations, service, storage());

    const row = conversations.get('g-1');
    expect(row?.directPeerId).toBe('bob');
    expect(row?.conversationType).toBe('direct');
    expect(row?.messages.map((m) => m.id)).toEqual(['live-1']);
  });
});
