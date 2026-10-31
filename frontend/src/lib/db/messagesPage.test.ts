/**
 * `getMessagesPage` reads a PAGE, not the conversation (backlog "IndexedDB message pages read the
 * whole conversation", performance audit 2026-10-12).
 *
 * IndexedDB: a reverse cursor on `[conversationId, orderAt]` stops at `limit`; the v11 upgrade
 * rewrote the string timestamps a phone backup left behind, which an index would otherwise order
 * after every number. SQLite: the same read is answered by `idx_messages_conv_order` with no temp
 * B-tree. Both page on the ORDER key - the server's receive time when the row knows it - since the
 * owner's decision of 2026-10-31 that a conversation is ordered by it.
 */
import 'fake-indexeddb/auto';
import { encryptData } from '../encryption';
import { toBase64 } from '$lib/utils/hex';
import { IndexedDbStorage } from './indexeddb';
import { storedOrderAt, toMessagePayload } from './messagePayload';
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

/**
 * Sixty rows a second apart, then ONE row stamped before all of them that the server accepted
 * LAST - a message an outbox held for minutes, or a clock running slow. By `sentAt` it is the
 * oldest row, more than a page deep; by the key the timeline sorts on it is the newest.
 */
const lateConversation = (): StoredMessage[] => [
  ...Array.from({ length: 60 }, (_, i) => message(`m-${i}`, 'conv', T0 + (i + 1) * 1000)),
  { ...message('late', 'conv', T0), serverTimestamp: T0 + 1_000_000 },
];

/** What a page and the load-older below it must read for {@link lateConversation}, page size 50. */
async function expectLateOnTop(
  read: (limit: number, before?: number) => Promise<StoredMessage[]>
): Promise<void> {
  const page = await read(50);
  expect(page.at(-1)!.id).toBe('late');
  expect(page[0].id).toBe('m-11');
  // The cursor `loadOlderMessages` takes: the order key of the oldest row held.
  const older = await read(50, Math.min(...page.map(storedOrderAt)));
  expect(older.map((m) => m.id)).toEqual(Array.from({ length: 11 }, (_, i) => `m-${i}`));
}

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

describe('IndexedDbStorage pages on the order key', () => {
  it('a late message more than a page deep by sentAt is on the first page after a reload', async () => {
    const name = `late-${Date.now()}-${n++}`;
    const before = new IndexedDbStorage(name);
    await before.init();
    await before.saveMessages(lateConversation(), KEY);
    await before.close();

    const storage = new IndexedDbStorage(name);
    await storage.init();
    await expectLateOnTop((limit, at) => storage.getMessagesPage('conv', KEY, limit, at));
    await storage.close();
  });

  it('keys the rows a v11 build stored, once, and the late one lands on top', async () => {
    const userId = `v11-${Date.now()}-${n++}`;
    // A database as a v11 build left it: both older indexes, rows with no `orderAt`.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`CanariDB_${userId}`, 11);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('byConversation', 'conversationId', { unique: false });
        store.createIndex('byConversationTime', ['conversationId', 'timestamp'], { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await Promise.all(
      lateConversation().map(async (msg) => ({
        id: msg.id,
        conversationId: msg.conversationId,
        timestamp: msg.timestamp,
        ...(await encryptData(toMessagePayload(msg), KEY)),
      }))
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      for (const row of rows) tx.objectStore('messages').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const storage = new IndexedDbStorage(userId);
    await storage.init();
    await expectLateOnTop((limit, at) => storage.getMessagesPage('conv', KEY, limit, at));

    // Keyed once: the next page reads its rows off the index and decrypts nothing else.
    const getAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    expect(await storage.getMessagesPage('conv', KEY, 5)).toHaveLength(5);
    expect(getAll).not.toHaveBeenCalled();
    getAll.mockRestore();
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
  // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
  // browser one, and Vite refuses to bundle a Node built-in named in an import.
  const newEngine = () => new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');

  async function initialisedSqlite(engine = newEngine()) {
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

  it('walks the conversation-order index instead of sorting the conversation', async () => {
    const { storage, engine, selects, positional } = await initialisedSqlite();

    for (const before of [undefined, T0]) {
      selects.length = 0;
      await storage.getMessagesPage('conv', KEY, 50, before);
      const sql = selects.find((s) => s.includes('ORDER BY order_at DESC'));
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
      expect(plan).toMatch(/USING INDEX idx_messages_conv_order/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('a late message more than a page deep by sentAt is on the first page', async () => {
    const { storage, engine } = await initialisedSqlite();
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    await storage.saveMessages(lateConversation(), KEY);
    await expectLateOnTop((limit, at) => storage.getMessagesPage('conv', KEY, limit, at));
  });

  it('the v16 step keys a v15 store on its first page read, once, and drops the sentAt index', async () => {
    // A file as a v15 build left it: no `order_at`, the `timestamp` page index.
    const engine = newEngine();
    engine.exec(
      'CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT, updated_at INTEGER, read_watermarks TEXT, history_floor INTEGER, image_media_id TEXT, awaiting_admission INTEGER)'
    );
    engine.exec(
      'CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, timestamp INTEGER, iv TEXT, cipher_text TEXT)'
    );
    engine.exec('CREATE INDEX idx_messages_conv_time ON messages(conversation_id, timestamp)');
    const insert = engine.prepare(
      'INSERT INTO messages (id, conversation_id, timestamp, iv, cipher_text) VALUES (?, ?, ?, ?, ?)'
    );
    for (const msg of lateConversation()) {
      const sealed = await encryptData(toMessagePayload(msg), KEY);
      insert.run(
        msg.id,
        msg.conversationId,
        msg.timestamp,
        toBase64(sealed.iv),
        toBase64(sealed.cipherText)
      );
    }
    engine.exec('PRAGMA user_version = 15');

    const { storage, selects } = await initialisedSqlite(engine);
    const indexes = (
      engine.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_messages_conv_order');
    expect(indexes).not.toContain('idx_messages_conv_time');

    await expectLateOnTop((limit, at) => storage.getMessagesPage('conv', KEY, limit, at));
    expect(
      engine.prepare('SELECT COUNT(*) AS n FROM messages WHERE order_at IS NULL').get()
    ).toEqual({ n: 0 });

    // Keyed once: the derivation probe finds nothing, so no row is decrypted twice.
    selects.length = 0;
    await storage.getMessagesPage('conv', KEY, 5);
    expect(selects.filter((s) => s.includes('order_at IS NULL'))).toHaveLength(1);
  });
});
