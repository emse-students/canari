/**
 * The feed's stored first pages (`$lib/posts/feedStore`): sealed under the device key on both
 * backends, replaced by a save, unreadable under another key, and gone after a delete or a reset.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { IStorage } from './types';

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

  it('opens nothing under another device key, and says so instead of throwing', async () => {
    const storage = await open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await storage.saveFeedPage('feed:all', { posts: ['a'] }, KEY);

    expect(await storage.getFeedPage('feed:all', OTHER_KEY)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[FEED-STORE]'));
    warn.mockRestore();
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
