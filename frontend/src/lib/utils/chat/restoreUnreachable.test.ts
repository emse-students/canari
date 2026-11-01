// @vitest-environment happy-dom
/**
 * A RESTORE WHOSE SERVER GOT NO ANSWER STOPS ITS CATCH-UP; ONE THAT GOT AN ANSWER KEEPS IT.
 *
 * Measured on production (`1.5.1`, a phone at a cold start with no network): the history batch got
 * no answer, each of 125 conversations then replayed its own page and took the mailbox barrier, and
 * 125 history reads plus 125 pulls left within one second, every one failing. A transport failure is
 * a fact about the link, so it stops the archive replays for the pass; a refusal is an answer about
 * some groups, and those groups still read their own page.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import { connectivity } from '$lib/stores/connectivity.svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
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
    getDismissedGroups: vi.fn(async () => []),
    ...overrides,
  };
}

function restore(
  conversations: SvelteMap<string, Conversation>,
  service: ReturnType<typeof mls>,
  onArchiveReplaysSkipped: (ids: string[]) => void = vi.fn()
) {
  return loadExistingConversations({
    onArchiveReplaysSkipped,
    storage: {
      getConversations: vi.fn(async () => [
        { id: 'g-1', name: 'Equipe', lifecycle: 'active' },
        { id: 'g-2', name: 'Autre', lifecycle: 'active' },
      ]),
      saveConversation: vi.fn(async () => {}),
      getMessagesPage: vi.fn(async (id: string) => (id === 'g-1' ? [STORED] : [])),
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
    log: vi.fn(),
  } as never);
}

describe('the restore against a server that got no answer', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    replay.mockClear();
    connectivity.reset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    connectivity.reset();
  });

  /** What the real delivery API does on no answer: tells the store, then throws (typed). */
  const noAnswer = (e: unknown) => {
    connectivity.notifyServerUnreachable();
    throw e;
  };

  it('skips every archive replay when the batch got no answer, says so once, and hands them on', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const service = mls({
      fetchHistoryBatch: vi.fn(async () =>
        noAnswer(new TransportFailureError(new TypeError('Failed to fetch')))
      ),
    });
    const skipped = vi.fn();

    await restore(conversations, service, skipped);

    expect(replay).not.toHaveBeenCalled();
    // Owed to the next reconnect - the restore does not run again on its own.
    expect(skipped).toHaveBeenCalledExactlyOnceWith(['g-1', 'g-2']);
    // The local half still ran: the stored page is on the row.
    expect(conversations.get('g-1')?.messages.map((m) => m.id)).toEqual(['stored-1']);
    const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      lines.filter((l: string) => l.includes('[CATCHUP] the server got no answer'))
    ).toHaveLength(1);
  });

  it('does not even send the batch when the group list got no answer', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const service = mls({
      getUserGroups: vi.fn(async () =>
        noAnswer(new TransportFailureError('error sending request for url (...)'))
      ),
    });

    await restore(conversations, service);

    expect(service.fetchHistoryBatch).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('keeps the per-group replay for groups a chunk left out on an ANSWER', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    // A refused chunk: the batch resolves, its groups absent from the map.
    const service = mls();

    await restore(conversations, service);

    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls.map((c: unknown[]) => (c[0] as { id: string }).id).sort()).toEqual([
      'g-1',
      'g-2',
    ]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('[CATCHUP] the server'));
  });

  // Review of #2726: ONE deadline on a slow but working link is not a link known down, and skipping
  // every replay on it would be a regression against the per-group path.
  it('keeps the per-group replay when the batch hit a deadline on a link not known down', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const service = mls({
      fetchHistoryBatch: vi.fn(async () => {
        throw new RequestDeadlineError('read', 30_000, 'POST', '/api/mls/history/batch', 0);
      }),
    });
    const skipped = vi.fn();
    expect(connectivity.isOffline).toBe(false);

    await restore(conversations, service, skipped);

    expect(replay).toHaveBeenCalledTimes(2);
    expect(skipped).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('[CATCHUP] the server'));
  });
});
