// @vitest-environment happy-dom
/**
 * A TAB WITHOUT THE LEADER COPY RESTORES FROM ITS STORE AND DECRYPTS NOTHING (2026-11-10).
 *
 * Production `1.6.9`: a follower tab's login ran the restore's archive replay inside a bulk-ingest
 * window, which advanced the follower's own ratchet copy, and the window's close checkpointed that
 * copy - "Encrypted state checkpoint persisted" five times in nine minutes from a tab that had logged
 * "Another tab is active". The leader's own writes were refused as stale behind it, so the disk held a
 * copy behind the leader's commits. The leader replays every archive at its own restore; a follower
 * draws the stored pages, opens no window and asks the server for no archive.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { noteMlsStateLoaded, resetStateAuthorityForTests } from '$lib/mls-client/stateAuthority';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const publishTabMessageUpdate = vi.hoisted(() => vi.fn());
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>()),
  publishTabMessageUpdate,
}));

const replay = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./history')>()),
  replayConversationHistory: replay,
}));

import { loadExistingConversations } from './conversations';

const STORED = {
  id: 'stored-1',
  conversationId: 'g-1',
  senderId: 'bob',
  content: 'from yesterday',
  timestamp: 1_000,
};

function mls() {
  return {
    getLocalGroups: vi.fn(() => ['g-1', 'g-2']),
    getUserGroups: vi.fn(async () => []),
    fetchHistoryBatch: vi.fn(async () => new Map()),
    notifyConversationsRestored: vi.fn(),
    notifyConversationRowsSeeded: vi.fn(),
    beginBulkIngest: vi.fn(),
    endBulkIngest: vi.fn(),
    persistCheckpoint: vi.fn(async () => {}),
    isDistributionGroup: vi.fn(() => false),
    getDismissedGroups: vi.fn(async () => ({ kind: 'listed' as const, groupIds: [] })),
  };
}

/** What the replay of g-1 stored, read back after it. */
const REPLAYED = { ...STORED, id: 'replayed-1', content: 'from the archive', timestamp: 2_000 };

function restore(conversations: SvelteMap<string, Conversation>, service: ReturnType<typeof mls>) {
  const log = vi.fn();
  // g-1's page before its replay, then the page the replay left in the store.
  let g1Reads = 0;
  const done = loadExistingConversations({
    onArchiveReplaysSkipped: vi.fn(),
    storage: {
      getConversations: vi.fn(async () => [
        { id: 'g-1', name: 'Equipe', lifecycle: 'active' },
        { id: 'g-2', name: 'Autre', lifecycle: 'active' },
      ]),
      saveConversation: vi.fn(async () => {}),
      getMessagesPage: vi.fn(async (id: string) => {
        if (id !== 'g-1') return [];
        g1Reads += 1;
        return g1Reads === 1 ? [STORED] : [STORED, REPLAYED];
      }),
      deleteMessagesForConversation: vi.fn(async () => {}),
      getMessages: vi.fn(async () => []),
      deleteConversation: vi.fn(async () => {}),
    },
    mlsService: service,
    conversations,
    messageReactions: new SvelteMap(),
    userId: 'u1',
    deviceKeyB64: 'k',
    archivedConversationIds: [],
    historyBaseUrl: '',
    onArchivedIdsChange: vi.fn(),
    log,
  } as never);
  return { done, log };
}

describe('the restore in a tab without the leader copy', () => {
  beforeEach(() => {
    replay.mockClear();
    publishTabMessageUpdate.mockClear();
  });
  afterEach(() => resetStateAuthorityForTests());

  it('draws the stored pages, replays no archive and opens no bulk window', async () => {
    noteMlsStateLoaded(false);
    const conversations = new SvelteMap<string, Conversation>();
    const service = mls();

    const { done, log } = restore(conversations, service);
    await done;

    expect(replay).not.toHaveBeenCalled();
    expect(service.fetchHistoryBatch).not.toHaveBeenCalled();
    // No window, so no close that checkpoints this copy.
    expect(service.beginBulkIngest).not.toHaveBeenCalled();
    expect(service.endBulkIngest).not.toHaveBeenCalled();
    expect(service.persistCheckpoint).not.toHaveBeenCalled();
    expect(conversations.get('g-1')?.messages.map((m) => m.id)).toEqual(['stored-1']);
    const said = log.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(said.filter((l) => l.includes('[RESTORE] Follower tab'))).toHaveLength(1);
  });

  it('the leader still replays every archive inside one window', async () => {
    noteMlsStateLoaded(true);
    const conversations = new SvelteMap<string, Conversation>();
    const service = mls();

    await restore(conversations, service).done;

    expect(replay).toHaveBeenCalledTimes(2);
    expect(service.fetchHistoryBatch).toHaveBeenCalledTimes(1);
    expect(service.beginBulkIngest).toHaveBeenCalledTimes(1);
    expect(service.endBulkIngest).toHaveBeenCalledTimes(1);
  });

  /**
   * THE FOLLOWER'S ONLY SOURCE FOR WHAT THE LEADER'S REPLAY STORED (review of #3326): before this PR
   * a follower replayed for itself; now it draws the store once, so an open follower kept a page the
   * replay had made incomplete until its next load.
   */
  it('the leader tells the follower tabs what its replay added, on the live batch event', async () => {
    noteMlsStateLoaded(true);
    const conversations = new SvelteMap<string, Conversation>();

    await restore(conversations, mls()).done;

    const batches = publishTabMessageUpdate.mock.calls.map((c: unknown[]) => c[0]);
    expect(batches).toEqual([
      expect.objectContaining({
        type: 'messages_batch',
        conversationId: 'g-1',
        messages: [expect.objectContaining({ id: 'replayed-1' })],
        lastMessageAt: 2_000,
      }),
    ]);
  });
});
