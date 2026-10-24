// @vitest-environment happy-dom
/**
 * The feed's stored first pages (`$lib/posts/feedStore`): sealed under the device key on both
 * backends, replaced by a save, unreadable under another key, and gone after a delete or a reset.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import { FeedPageUnreadableError, type IStorage } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
let n = 0;

/** A `SqliteStorage` over a real in-memory SQLite (`node:sqlite`) holding the `feed_pages` table. */
function sqliteStorage(): { storage: SqliteStorage; raw: () => unknown[] } {
  // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
  // browser one, and Vite refuses to bundle a Node built-in named in an import.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const engine = new DatabaseSync(':memory:');
  engine.exec('CREATE TABLE feed_pages (feed_key TEXT PRIMARY KEY, iv TEXT, cipher_text TEXT)');
  // The plugin binds `$1`; `?1` is the same positional parameter for `node:sqlite`.
  const bind = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
  const db = {
    execute: async (sql: string, params: unknown[] = []) =>
      engine.prepare(bind(sql)).run(...(params as string[])),
    select: async (sql: string, params: unknown[] = []) =>
      engine.prepare(bind(sql)).all(...(params as string[])),
  };
  const storage = new SqliteStorage('u');
  (storage as unknown as { db: unknown }).db = db;
  return { storage, raw: () => engine.prepare('SELECT * FROM feed_pages').all() };
}

async function idbStorage(): Promise<IndexedDbStorage> {
  const storage = new IndexedDbStorage(`feed-pages-${Date.now()}-${n++}`);
  await storage.init();
  return storage;
}

const backends: Array<[string, () => Promise<IStorage>]> = [
  ['IndexedDbStorage', idbStorage],
  ['SqliteStorage', async () => sqliteStorage().storage],
];

describe.each(backends)('%s stored feed pages', (_name, open) => {
  it('opens what it sealed, and a second save replaces the first', async () => {
    const storage = await open();
    await storage.saveFeedPage('feed:all', { posts: ['a'] }, KEY);
    await storage.saveFeedPage('feed:all', { posts: ['b'] }, KEY);
    await storage.saveFeedPage('feed:followed', { posts: ['c'] }, KEY);

    expect(await storage.getFeedPage('feed:all', KEY)).toEqual({ posts: ['b'] });
    expect(await storage.getFeedPage('feed:followed', KEY)).toEqual({ posts: ['c'] });
    expect(await storage.getFeedPage('feed:custom', KEY)).toBeNull();
  });

  it('refuses a page sealed under another device key with a TYPED error, never a null', async () => {
    const storage = await open();
    await storage.saveFeedPage('feed:all', { posts: ['a'] }, KEY);

    await expect(storage.getFeedPage('feed:all', OTHER_KEY)).rejects.toBeInstanceOf(
      FeedPageUnreadableError
    );
  });

  it('deletes every page and counts them', async () => {
    const storage = await open();
    await storage.saveFeedPage('feed:all', { posts: [] }, KEY);
    await storage.saveFeedPage('feed:associations', { posts: [] }, KEY);

    expect(await storage.deleteFeedPages()).toBe(2);
    expect(await storage.getFeedPage('feed:all', KEY)).toBeNull();
    expect(await storage.deleteFeedPages()).toBe(0);
  });
});

describe('the sealed page holds no readable post text', () => {
  it('SQLite keeps only the tab name in clear', async () => {
    const { storage, raw } = sqliteStorage();
    await storage.saveFeedPage('feed:all', { posts: [{ markdown: 'secret words' }] }, KEY);

    const rows = raw() as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].feed_key).toBe('feed:all');
    expect(JSON.stringify(rows[0])).not.toContain('secret words');
  });
});

describe('an account reset empties the stored feed', () => {
  it('IndexedDB clear() takes the feed pages with the rest', async () => {
    const storage = await idbStorage();
    await storage.saveFeedPage('feed:all', { posts: ['a'] }, KEY);
    await storage.clear();
    expect(await storage.getFeedPage('feed:all', KEY)).toBeNull();
    await storage.close();
  });
});

/** Opens `name` at v9 with the stores v9 had, holding one conversation, the way the last build left it. */
function openV9WithData(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 9);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('conversations', { keyPath: 'id' });
      db.createObjectStore('messages', { keyPath: 'id' }).createIndex(
        'byConversation',
        'conversationId',
        { unique: false }
      );
      const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
      outbox.createIndex('byConversation', 'conversationId', { unique: false });
      outbox.createIndex('bySentAt', 'sentAt', { unique: false });
      const graine = db.createObjectStore('graine', { keyPath: 'sessionId' });
      graine.createIndex('byChannel', 'channelId', { unique: false });
      graine.createIndex('byWorkspace', 'workspaceId', { unique: false });
      db.createObjectStore('pendingGroupExits', { keyPath: 'groupId' });
      db.createObjectStore('distributionGroups', { keyPath: 'groupId' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').put({ id: 'g1', name: 'Kept', lifecycle: 'active' });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('the v9 -> v10 upgrade', () => {
  it('adds the feed store and keeps every row already there', async () => {
    const user = `upgrade-${Date.now()}-${n++}`;
    await openV9WithData(`CanariDB_${user}`);

    const storage = new IndexedDbStorage(user);
    await storage.init();

    expect((await storage.getConversations()).map((c) => c.id)).toEqual(['g1']);
    await storage.saveFeedPage('feed:all', { posts: ['a'] }, KEY);
    expect(await storage.getFeedPage('feed:all', KEY)).toEqual({ posts: ['a'] });
    await storage.close();
  });

  it('a tab holding the older connection lets go when a newer one upgrades, instead of blocking it', async () => {
    const storage = await idbStorage();
    const { dbName: name, db } = storage as unknown as { dbName: string; db: IDBDatabase };
    // Read, not written down: a literal "next version" goes stale on the next schema bump.
    const next = db.version + 1;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});

    // A newer bundle asking for the next version, while this connection is still open.
    const upgraded = await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open(name, next);
      req.onblocked = () => reject(new Error('blocked by the older connection'));
      req.onsuccess = () => {
        const version = req.result.version;
        req.result.close();
        resolve(version);
      };
      req.onerror = () => reject(req.error);
    });

    expect(upgraded).toBe(next);
    expect(storage.isOpen).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
