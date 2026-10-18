/**
 * `getMessagesPage` reads a PAGE, not the conversation (backlog "IndexedDB message pages read the
 * whole conversation", performance audit 2026-10-12).
 *
 * IndexedDB: a reverse cursor on `[conversationId, timestamp]` stops at `limit`; the v11 upgrade
 * builds that index over the rows already stored and rewrites the string timestamps a phone backup
 * left behind, which an index would otherwise order after every number. SQLite: the same read is
 * answered by `idx_messages_conv_time` with no temp B-tree.
 */
import 'fake-indexeddb/auto';
import { encryptData } from '../encryption';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { StoredMessage } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const T0 = 1_700_000_000_000;
let n = 0;

const message = (id: string, conversationId: string, timestamp: number): StoredMessage => ({
  id,
  conversationId,
  senderId: 'peer',
  content: id,
  timestamp,
});

/** A fresh, initialised store under a name no other case uses. */
async function openStore(): Promise<IndexedDbStorage> {
  const storage = new IndexedDbStorage(`page-${Date.now()}-${n++}`);
  await storage.init();
  return storage;
}

describe('IndexedDbStorage.getMessagesPage', () => {
  it('returns the newest `limit` rows of ONE conversation, oldest first, and pages older exclusively', async () => {
    const storage = await openStore();
    // Written out of time order and interleaved with a second conversation, so neither insertion
    // order nor id order can produce the expected answer by accident.
    const ids = [7, 2, 9, 0, 5, 3, 8, 1, 6, 4];
    await storage.saveMessages(
      ids.flatMap((i) => [
        message(`a-${i}`, 'conv-a', T0 + i * 1000),
        message(`b-${i}`, 'conv-b', T0 + i * 1000 + 500),
      ]),
      KEY
    );

    const newest = await storage.getMessagesPage('conv-a', KEY, 3);
    expect(newest.map((m) => m.id)).toEqual(['a-7', 'a-8', 'a-9']);

    const older = await storage.getMessagesPage('conv-a', KEY, 3, newest[0].timestamp);
    expect(older.map((m) => m.id)).toEqual(['a-4', 'a-5', 'a-6']);

    const rest = await storage.getMessagesPage('conv-a', KEY, 50, T0 + 1000);
    expect(rest.map((m) => m.id)).toEqual(['a-0']);
    await storage.close();
  });

  it('reads `limit` rows off the index and never the whole conversation', async () => {
    // The case that fails on the old read: it `getAll`ed every row of the conversation through
    // `byConversation` and sorted them in JS to keep the page.
    const storage = await openStore();
    await storage.saveMessages(
      Array.from({ length: 200 }, (_, i) => message(`m-${i}`, 'conv', T0 + i)),
      KEY
    );
    const getAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const advance = vi.spyOn(IDBCursor.prototype, 'continue');

    const page = await storage.getMessagesPage('conv', KEY, 5);

    expect(page).toHaveLength(5);
    expect(getAll).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledTimes(4);
    getAll.mockRestore();
    advance.mockRestore();
    await storage.close();
  });

  it('places a row restored from a phone backup, whose timestamp arrived as a string', async () => {
    const storage = await openStore();
    await storage.saveMessages(
      [message('m-1', 'conv', T0 + 1000), message('m-3', 'conv', T0 + 3000)],
      KEY
    );
    const sealed = await encryptData({ senderId: 'peer', content: 'm-2' }, KEY);

    await storage.importEncryptedRow({
      id: 'm-2',
      conversationId: 'conv',
      timestamp: String(T0 + 2000) as unknown as number,
      ...sealed,
    });

    const page = await storage.getMessagesPage('conv', KEY, 2);
    expect(page.map((m) => [m.id, m.timestamp])).toEqual([
      ['m-2', T0 + 2000],
      ['m-3', T0 + 3000],
    ]);
    await storage.close();
  });
});

describe('the v10 -> v11 upgrade', () => {
  /** A database as a v10 build left it: `messages` with `byConversation` only, rows written raw. */
  async function v10Database(name: string, rows: Array<Record<string, unknown>>): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 10);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('byConversation', 'conversationId', { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      for (const row of rows) tx.objectStore('messages').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  it('indexes the rows already stored and rewrites a string timestamp as a number', async () => {
    const userId = `upgrade-${Date.now()}-${n++}`;
    const row = async (id: string, timestamp: unknown) => ({
      id,
      conversationId: 'conv',
      timestamp,
      ...(await encryptData({ senderId: 'peer', content: id }, KEY)),
    });
    await v10Database(`CanariDB_${userId}`, [
      await row('m-1', T0 + 1000),
      // What a backup taken on Android wrote: newer than m-1, but a string - an index would order
      // it after every number of the conversation, so the page would read it as the newest.
      await row('m-2', String(T0 + 2000)),
      await row('m-3', T0 + 3000),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const storage = new IndexedDbStorage(userId);
    await storage.init();

    const page = await storage.getMessagesPage('conv', KEY, 2);
    expect(page.map((m) => [m.id, m.timestamp])).toEqual([
      ['m-2', T0 + 2000],
      ['m-3', T0 + 3000],
    ]);
    expect(warn.mock.calls.some(([line]) => String(line).includes('1 message row(s)'))).toBe(true);
    warn.mockRestore();
    await storage.close();
  });
});

describe('SqliteStorage.getMessagesPage', () => {
  /**
   * `SqliteStorage.init` run for real against `node:sqlite`, so the index under test is the one the
   * production code creates - not a copy of its statement written into the test.
   */
  async function initialisedSqlite() {
    // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
    // browser one, and Vite refuses to bundle a Node built-in named in an import.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const engine = new DatabaseSync(':memory:');
    /** The plugin binds `$n`; `?n` is the same positional parameter for `node:sqlite`. */
    const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
    const selects: string[] = [];
    const db = {
      execute: async (sql: string, params: unknown[] = []) => {
        engine.prepare(positional(sql)).run(...(params as never[]));
      },
      select: async (sql: string, params: unknown[] = []) => {
        selects.push(sql);
        return engine.prepare(positional(sql)).all(...(params as never[]));
      },
      close: async () => undefined,
    };
    vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
    const storage = new SqliteStorage(`sqlite-page-${n++}`);
    await storage.init();
    return { storage, engine, selects, positional };
  }

  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-sql');
  });

  it('walks the conversation-time index instead of sorting the conversation', async () => {
    const { storage, engine, selects, positional } = await initialisedSqlite();

    for (const before of [undefined, T0]) {
      selects.length = 0;
      await storage.getMessagesPage('conv', KEY, 50, before);
      const sql = selects.find((s) => s.includes('ORDER BY timestamp DESC'));
      expect(sql).toBeDefined();
      const params = before === undefined ? ['conv', 50] : ['conv', before, 50];
      const plan = (
        engine
          .prepare(`EXPLAIN QUERY PLAN ${positional(sql!)}`)
          .all(...(params as never[])) as Array<{
          detail: string;
        }>
      )
        .map((p) => p.detail)
        .join(' | ');
      expect(plan).toMatch(/USING INDEX idx_messages_conv_time/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });
});
