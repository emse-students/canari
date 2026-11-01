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
import { oldestPageKey, toMessagePayload } from './messagePayload';
import { ORDER_KEY_CHUNK_ROWS } from './orderKeyDerivation';
import { SqliteStorage } from './sqlite';
import { ORDER_AT_FILL_ROWS_PER_STATEMENT } from './sqliteBatch';
import { MESSAGE_PROVISIONAL_ORDER_FILL } from './sqliteMigrations';
import type { PageKey, StoredMessage } from './types';

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
  read: (limit: number, before?: PageKey) => Promise<StoredMessage[]>
): Promise<void> {
  const page = await read(50);
  expect(page.at(-1)!.id).toBe('late');
  expect(page[0].id).toBe('m-11');
  // The cursor `loadOlderMessages` takes: the lowest page key the store handed back.
  const older = await read(50, oldestPageKey(page));
  expect(older.map((m) => m.id)).toEqual(Array.from({ length: 11 }, (_, i) => `m-${i}`));
}

/** A device key no row of these cases was sealed with. */
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

/**
 * Sixty rows imported as a backup would (provisional keys), one of which - `rises`, sixth from the
 * bottom by sentAt - the server took among the newest. On provisional keys it is below the first
 * page; keyed for real, it is inside it.
 */
async function importRisingConversation(storage: {
  importEncryptedRow: IndexedDbStorage['importEncryptedRow'];
}): Promise<void> {
  const rows = Array.from({ length: 60 }, (_, i) =>
    message(`m-${String(i).padStart(2, '0')}`, 'conv', T0 + (i + 1) * 1000)
  );
  rows[5] = { ...rows[5], id: 'rises', serverTimestamp: T0 + 55_500 };
  for (const msg of rows) {
    await storage.importEncryptedRow({
      id: msg.id,
      conversationId: 'conv',
      timestamp: msg.timestamp,
      ...(await encryptData(toMessagePayload(msg), KEY)),
    });
  }
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

    const older = await storage.getMessagesPage('conv-a', KEY, 3, oldestPageKey(newest));
    expect(older.map((m) => m.id)).toEqual(['a-4', 'a-5', 'a-6']);

    const rest = await storage.getMessagesPage('conv-a', KEY, 50, {
      orderAt: T0 + 1000,
      id: 'a-1',
      provisional: false,
    });
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
    // The first page does not wait for the keys: it is drawn on the provisional ones, sentAt order.
    const first = await storage.getMessagesPage('conv', KEY, 50);
    expect(first.every((m) => m.pageKey?.provisional)).toBe(true);
    expect(first.some((m) => m.id === 'late')).toBe(false);
    expect(await storage.orderKeysDerived('conv', KEY)).toEqual({
      derived: 61,
      unreadable: 0,
      deferred: 0,
    });
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

  /** Seams a case uses to hold a statement back, or to fail one, as a killed process would. */
  interface EngineHooks {
    beforeSelect?: (sql: string) => Promise<void> | void;
    beforeExecute?: (sql: string) => void;
  }

  async function initialisedSqlite(engine = newEngine(), hooks: EngineHooks = {}) {
    /** The plugin binds `$n`; `?n` is the same positional parameter for `node:sqlite`. */
    const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
    const selects: string[] = [];
    const db = {
      execute: async (sql: string, params: unknown[] = []) => {
        hooks.beforeExecute?.(sql);
        engine.prepare(positional(sql)).run(...(params as never[]));
      },
      select: async (sql: string, params: unknown[] = []) => {
        selects.push(sql);
        await hooks.beforeSelect?.(sql);
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
      await storage.getMessagesPage(
        'conv',
        KEY,
        50,
        before === undefined ? undefined : { orderAt: before, id: 'm', provisional: false }
      );
      const sql = selects.find((s) => s.includes('ORDER BY order_at DESC'));
      expect(sql).toBeDefined();
      const params = before === undefined ? ['conv', 50] : ['conv', before, 'm', 50];
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

  it('the v16 step keys a v15 store provisionally, derives it behind the first page, once, and drops the sentAt index', async () => {
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

    // Every row is in the page index from the first read on, keyed provisionally on its sentAt.
    expect(
      engine.prepare('SELECT COUNT(*) AS n FROM messages WHERE order_pending = 1').get()
    ).toEqual({ n: 61 });
    const first = await storage.getMessagesPage('conv', KEY, 50);
    expect(first.every((m) => m.pageKey?.provisional)).toBe(true);
    expect(first.some((m) => m.id === 'late')).toBe(false);
    await storage.orderKeysDerived('conv', KEY);
    await expectLateOnTop((limit, at) => storage.getMessagesPage('conv', KEY, limit, at));
    expect(
      engine
        .prepare(
          'SELECT COUNT(*) AS n FROM messages WHERE order_at IS NULL OR order_pending IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 0 });

    // Keyed once: the page read probes for a pending row, finds none, and reads no chunk.
    selects.length = 0;
    await storage.getMessagesPage('conv', KEY, 5);
    expect(selects.filter((s) => s.includes('order_pending = 1 LIMIT 1'))).toHaveLength(1);
    expect(selects.filter((s) => s.includes('ORDER BY id LIMIT'))).toHaveLength(0);
  });

  /**
   * `count` provisional rows imported as a backup would, plus the late one; sentAt order = id order.
   * The ordinary rows share ONE sealed payload (it carries no id and no server time), so the case
   * pays for the derivation's decryptions, not for as many encryptions.
   */
  async function importLargeConversation(
    storage: { importEncryptedRow: SqliteStorage['importEncryptedRow'] },
    count: number
  ): Promise<void> {
    const sealed = await encryptData({ senderId: 'peer', content: 'row' }, KEY);
    for (let i = 0; i < count; i++) {
      await storage.importEncryptedRow({
        id: `m-${String(i).padStart(5, '0')}`,
        conversationId: 'conv',
        timestamp: T0 + (i + 1) * 1000,
        ...sealed,
      });
    }
    const late = { ...message('late', 'conv', T0), serverTimestamp: T0 + 100_000_000 };
    await storage.importEncryptedRow({
      id: late.id,
      conversationId: 'conv',
      timestamp: late.timestamp,
      ...(await encryptData(toMessagePayload(late), KEY)),
    });
  }

  it('a row written by an older build that opened the v16 file is keyed again on the next open', async () => {
    // A downgrade: the older build runs no migration above its own version and inserts with no
    // `order_at`. Then the upgrade back: the v16 step does not run again, the open-time fill does.
    const engine = newEngine();
    const first = await initialisedSqlite(engine);
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    await first.storage.saveMessages([message('kept', 'conv', T0 + 2000)], KEY);
    const sealed = await encryptData(
      toMessagePayload(message('older-build', 'conv', T0 + 1000)),
      KEY
    );
    engine
      .prepare(
        'INSERT OR REPLACE INTO messages (id, conversation_id, timestamp, iv, cipher_text) VALUES (?, ?, ?, ?, ?)'
      )
      .run('older-build', 'conv', T0 + 1000, toBase64(sealed.iv), toBase64(sealed.cipherText));

    const { storage, positional } = await initialisedSqlite(engine);
    const plan = (
      engine
        .prepare(`EXPLAIN QUERY PLAN ${positional(MESSAGE_PROVISIONAL_ORDER_FILL)}`)
        .all() as Array<{ detail: string }>
    )
      .map((p) => p.detail)
      .join(' | ');
    expect(plan).toMatch(/idx_messages_order_missing/);
    expect((await storage.getMessagesPage('conv', KEY, 50)).map((m) => m.id)).toEqual([
      'older-build',
      'kept',
    ]);
  });

  it('a large conversation: the first page never waits for its derivation, which runs in chunks behind it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { storage, engine, selects } = await initialisedSqlite(newEngine(), {
      // Every chunk read of the derivation is held until the case lets it go.
      beforeSelect: (sql) => (sql.includes('ORDER BY id LIMIT') ? gate : undefined),
    });
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    await importLargeConversation(storage, 1200);

    // Resolves with the derivation held at its first chunk: the page waited for nothing.
    const first = await storage.getMessagesPage('conv', KEY, 50);
    expect(first).toHaveLength(50);
    expect(first.every((m) => m.pageKey?.provisional)).toBe(true);
    expect(first.some((m) => m.id === 'late')).toBe(false);
    // A second read joins the run in flight instead of starting another.
    await storage.getMessagesPage('conv', KEY, 50);
    release();
    expect(await storage.orderKeysDerived('conv', KEY)).toEqual({
      derived: 1201,
      unreadable: 0,
      deferred: 0,
    });
    // ONE run, in chunks of ORDER_KEY_CHUNK_ROWS - though two page reads asked for it.
    const chunkReads = selects.filter((s) => s.includes('ORDER BY id LIMIT'));
    expect(chunkReads).toHaveLength(Math.ceil(1201 / ORDER_KEY_CHUNK_ROWS));

    const settled = await storage.getMessagesPage('conv', KEY, 50);
    expect(settled.at(-1)!.id).toBe('late');
    expect(settled.every((m) => m.pageKey?.provisional === false)).toBe(true);
  }, 60_000);

  it('a derivation killed mid-way keeps the chunks it wrote, and the next run reads only the rest', async () => {
    let fills = 0;
    let killed = true;
    const engine = newEngine();
    const { storage } = await initialisedSqlite(engine, {
      beforeExecute: (sql) => {
        if (!sql.startsWith('UPDATE messages SET order_at')) return;
        fills++;
        // The first chunk's statements land; the process dies on the next chunk's first write.
        const firstChunkStatements = Math.ceil(
          ORDER_KEY_CHUNK_ROWS / ORDER_AT_FILL_ROWS_PER_STATEMENT
        );
        if (killed && fills > firstChunkStatements) throw new Error('killed');
      },
    });
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    await importLargeConversation(storage, 1200);

    await expect(storage.orderKeysDerived('conv', KEY)).rejects.toThrow('killed');
    const pending = () =>
      (
        engine.prepare('SELECT COUNT(*) AS n FROM messages WHERE order_pending = 1').get() as {
          n: number;
        }
      ).n;
    expect(pending()).toBe(1201 - ORDER_KEY_CHUNK_ROWS);

    killed = false;
    expect(await storage.orderKeysDerived('conv', KEY)).toEqual({
      derived: 1201 - ORDER_KEY_CHUNK_ROWS,
      unreadable: 0,
      deferred: 0,
    });
    expect(pending()).toBe(0);
  }, 60_000);

  it('a row this key can never read is keyed on its sentAt for good, and the run goes on past it', async () => {
    const { storage, engine } = await initialisedSqlite();
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    await importLargeConversation(storage, 3);
    const foreign = await encryptData({ senderId: 'peer', content: 'x' }, OTHER_KEY);
    await storage.importEncryptedRow({
      id: 'foreign',
      conversationId: 'conv',
      timestamp: T0 + 500,
      ...foreign,
    });

    expect(await storage.orderKeysDerived('conv', KEY)).toEqual({
      derived: 4,
      unreadable: 1,
      deferred: 0,
    });
    expect(
      engine.prepare("SELECT order_at, order_pending FROM messages WHERE id = 'foreign'").get()
    ).toEqual({ order_at: T0 + 500, order_pending: null });
  });

  it('pages on the pair (orderAt, id): rows tied with the boundary are neither lost nor read twice', async () => {
    const { storage, engine } = await initialisedSqlite();
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    // Fifty-five rows on ONE key: a boundary on the key alone found nothing below the first page.
    await storage.saveMessages(
      Array.from({ length: 55 }, (_, i) => message(`m-${String(i).padStart(2, '0')}`, 'conv', T0)),
      KEY
    );
    const first = await storage.getMessagesPage('conv', KEY, 50);
    const older = await storage.getMessagesPage('conv', KEY, 50, oldestPageKey(first));
    expect(older.map((m) => m.id)).toEqual(['m-00', 'm-01', 'm-02', 'm-03', 'm-04']);
    expect(new Set([...first, ...older].map((m) => m.id)).size).toBe(55);
  });

  it('below a provisional boundary, waits for the keys and re-reads what rose above it', async () => {
    const { storage, engine } = await initialisedSqlite();
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    await importRisingConversation(storage);
    const first = await storage.getMessagesPage('conv', KEY, 50);
    expect(first.some((m) => m.id === 'rises')).toBe(false);
    const boundary = oldestPageKey(first)!;
    expect(boundary.provisional).toBe(true);

    const older = await storage.getMessagesPage('conv', KEY, 50, boundary);
    expect(older.some((m) => m.id === 'rises')).toBe(true);
    expect(new Set([...first, ...older].map((m) => m.id)).size).toBe(60);
  });
});

describe('IndexedDbStorage - provisional keys, derived behind the page', () => {
  it('a large conversation: the first page is drawn on provisional keys, then derived in chunks', async () => {
    const storage = await openStore();
    const sealed = await encryptData({ senderId: 'peer', content: 'row' }, KEY);
    for (let i = 0; i < 1200; i++) {
      await storage.importEncryptedRow({
        id: `m-${String(i).padStart(5, '0')}`,
        conversationId: 'conv',
        timestamp: T0 + (i + 1) * 1000,
        ...sealed,
      });
    }
    const late = { ...message('late', 'conv', T0), serverTimestamp: T0 + 100_000_000 };
    await storage.importEncryptedRow({
      id: late.id,
      conversationId: 'conv',
      timestamp: late.timestamp,
      ...(await encryptData(toMessagePayload(late), KEY)),
    });

    const first = await storage.getMessagesPage('conv', KEY, 50);
    expect(first.every((m) => m.pageKey?.provisional)).toBe(true);
    expect(first.some((m) => m.id === 'late')).toBe(false);
    expect(await storage.orderKeysDerived('conv', KEY)).toEqual({
      derived: 1201,
      unreadable: 0,
      deferred: 0,
    });
    const settled = await storage.getMessagesPage('conv', KEY, 50);
    expect(settled.at(-1)!.id).toBe('late');
    expect(settled.every((m) => m.pageKey?.provisional === false)).toBe(true);
    await storage.close();
  }, 60_000);

  it('a derivation killed mid-way keeps the chunk it wrote, and the next run reads only the rest', async () => {
    const name = `kill-${Date.now()}-${n++}`;
    const before = new IndexedDbStorage(name);
    await before.init();
    const sealed = await encryptData({ senderId: 'peer', content: 'row' }, KEY);
    for (let i = 0; i < 700; i++) {
      await before.importEncryptedRow({
        id: `m-${String(i).padStart(5, '0')}`,
        conversationId: 'conv',
        timestamp: T0 + i,
        ...sealed,
      });
    }
    // The process dies on the second chunk's write: its transaction never opens.
    const open = IDBDatabase.prototype.transaction;
    let writes = 0;
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<typeof open>
    ) {
      if (args[1] === 'readwrite' && ++writes > 1) throw new Error('killed');
      return open.apply(this, args);
    });
    await expect(before.orderKeysDerived('conv', KEY)).rejects.toThrow('killed');
    spy.mockRestore();
    await before.close();

    const after = new IndexedDbStorage(name);
    await after.init();
    expect(await after.orderKeysDerived('conv', KEY)).toEqual({
      derived: 700 - ORDER_KEY_CHUNK_ROWS,
      unreadable: 0,
      deferred: 0,
    });
    await after.close();
  }, 60_000);

  it('pages on the pair (orderAt, id): rows tied with the boundary are neither lost nor read twice', async () => {
    const storage = await openStore();
    await storage.saveMessages(
      Array.from({ length: 55 }, (_, i) => message(`m-${String(i).padStart(2, '0')}`, 'conv', T0)),
      KEY
    );
    const first = await storage.getMessagesPage('conv', KEY, 50);
    const older = await storage.getMessagesPage('conv', KEY, 50, oldestPageKey(first));
    expect(older.map((m) => m.id)).toEqual(['m-00', 'm-01', 'm-02', 'm-03', 'm-04']);
    expect(new Set([...first, ...older].map((m) => m.id)).size).toBe(55);
    await storage.close();
  });

  it('below a provisional boundary, waits for the keys and re-reads what rose above it', async () => {
    const storage = await openStore();
    await importRisingConversation(storage);
    const first = await storage.getMessagesPage('conv', KEY, 50);
    expect(first.some((m) => m.id === 'rises')).toBe(false);
    const boundary = oldestPageKey(first)!;
    expect(boundary.provisional).toBe(true);

    const older = await storage.getMessagesPage('conv', KEY, 50, boundary);
    expect(older.some((m) => m.id === 'rises')).toBe(true);
    expect(new Set([...first, ...older].map((m) => m.id)).size).toBe(60);
    await storage.close();
  });
});
