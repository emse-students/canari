/**
 * ONE CONTRACT, TWO IMPLEMENTATIONS, AND THE ONE THAT DID NOT HONOUR IT.
 *
 * `StorageBackend.getConversations` is documented "ordered by recency". `SqliteStorage` answers
 * `ORDER BY updated_at DESC` and always did; `IndexedDbStorage` returned `getAll()` - key order,
 * which for a conversations store is the group id, which is arbitrary - and its own docblock said
 * so ("unordered - callers should sort"), contradicting the interface it implements.
 *
 * Nothing caught it because each platform runs exactly one of the two, so the divergence could only
 * be seen by comparing the files. What it decided is not cosmetic: phase 2 of `restoreConversations`
 * walks this list one conversation at a time - serialised, because the WASM MLS client is not safe
 * to invoke concurrently - so the list IS the startup schedule. On a phone the conversation with
 * the newest message was replayed first; on the web it was replayed in group-id order.
 *
 * Pinned here against the STORE rather than against the caller, because that is where the promise
 * is written and where the other backend already keeps it.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import type { ConversationMeta } from './types';

const meta = (id: string, updatedAt: number): ConversationMeta => ({
  id,
  name: id,
  updatedAt,
  lifecycle: 'active',
});

describe('IndexedDbStorage.getConversations', () => {
  let storage: IndexedDbStorage;

  beforeEach(async () => {
    // A fresh database per case: `fake-indexeddb/auto` keeps one global registry for the file.
    storage = new IndexedDbStorage(`order-${Math.random().toString(36).slice(2)}`);
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('answers most-recently-updated first, whatever order the rows were written in', async () => {
    // Ids deliberately ASCENDING while the timestamps DESCEND: key order and recency order are
    // exact opposites here, so a backend that returns `getAll()` cannot pass by accident.
    await storage.saveConversation(meta('aaa', 1_000));
    await storage.saveConversation(meta('bbb', 3_000));
    await storage.saveConversation(meta('ccc', 2_000));

    const rows = await storage.getConversations();

    expect(rows.map((r) => r.id)).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('re-orders after an update, because the schedule follows the newest message', async () => {
    await storage.saveConversation(meta('aaa', 3_000));
    await storage.saveConversation(meta('bbb', 1_000));

    // A message arrives in the older conversation: it is now the one the user is looking at, and it
    // is the one the next startup must replay first.
    await storage.saveConversation(meta('bbb', 5_000));

    const rows = await storage.getConversations();

    expect(rows.map((r) => r.id)).toEqual(['bbb', 'aaa']);
  });
});
