// @vitest-environment happy-dom
/**
 * The replay's "was the store wiped under my cursor" check, run for every conversation on every
 * cold start, must COUNT the rows rather than decrypt them.
 *
 * It used to call `getMessages`, which decrypts the whole conversation - one AES-GCM call per row -
 * to read a `length`. On a device holding 20k messages that is 20k decrypts per cold start before a
 * single network page is asked for. Pinned on the real IndexedDB store with a count of decrypting
 * reads, never a clock.
 */
import 'fake-indexeddb/auto';

vi.mock('$lib/utils/chat/historyReconcile', () => ({
  escalateReconciliation: vi.fn().mockResolvedValue(true),
}));

import { IndexedDbStorage } from '$lib/db/indexeddb';
import type { StoredMessage } from '$lib/db/types';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import {
  readHistoryStreamCursor,
  replayConversationHistory,
  resetSeenCipherCacheForTests,
} from './history';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const USER = 'user-1';
const GROUP = 'group-1';
let n = 0;

const message = (i: number): StoredMessage => ({
  id: `m-${i}`,
  conversationId: GROUP,
  senderId: 'peer',
  content: JSON.stringify({ kind: 'text', text: `hello ${i}` }),
  timestamp: 1_700_000_000_000 + i,
});

async function replayWithCursor(storage: IndexedDbStorage) {
  localStorage.setItem(`history_last_stream_id:${USER}:${GROUP}`, '1700000000000-0');
  const mlsService = createMlsServiceStub({
    getLocalGroups: vi.fn().mockReturnValue([GROUP]),
    fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
  });
  await replayConversationHistory({
    mlsService,
    id: GROUP,
    contactName: 'peer',
    userId: USER,
    deviceKey: () => KEY,
    storage,
    getConversation: () => undefined,
    setConversation: () => undefined,
    messageReactions: new Map(),
    log: () => undefined,
  });
}

describe('the cursor check of the history replay', () => {
  let storage: IndexedDbStorage;

  beforeEach(async () => {
    localStorage.clear();
    resetSeenCipherCacheForTests();
    storage = new IndexedDbStorage(`cursor-check-${n++}`);
    await storage.init();
  });

  afterEach(() => storage.close());

  it('decrypts nothing to learn that the conversation holds messages, and keeps the cursor', async () => {
    await storage.saveMessages(
      Array.from({ length: 50 }, (_, i) => message(i)),
      KEY
    );
    const fullReads = vi.spyOn(storage, 'getMessages');
    const counts = vi.spyOn(storage, 'countMessages');

    await replayWithCursor(storage);

    expect(counts).toHaveBeenCalledTimes(1);
    expect(fullReads).not.toHaveBeenCalled();
    expect(readHistoryStreamCursor(USER, GROUP)).toBe('1700000000000-0');
  });

  it('still drops the cursor of a store that holds nothing, so the history is fetched whole', async () => {
    await replayWithCursor(storage);

    expect(readHistoryStreamCursor(USER, GROUP)).toBeUndefined();
  });
});

describe('IndexedDbStorage.countMessages', () => {
  it('counts the rows of one conversation only', async () => {
    const storage = new IndexedDbStorage(`count-${n++}`);
    await storage.init();
    await storage.saveMessages(
      [message(1), message(2), { ...message(3), conversationId: 'other' }],
      KEY
    );
    expect(await storage.countMessages(GROUP)).toBe(2);
    expect(await storage.countMessages('other')).toBe(1);
    expect(await storage.countMessages('none')).toBe(0);
    storage.close();
  });
});
