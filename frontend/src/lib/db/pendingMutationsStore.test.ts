/**
 * The store of mutations whose message is not here yet (`PendingMutation`) and the insert-only
 * message write (`saveMessagesIfAbsent`), on BOTH backends - IndexedDB through `fake-indexeddb`,
 * SQLite through `SqliteStorage.init` run for real against `node:sqlite` - and the upgrade of a
 * database each backend's previous build left behind (IndexedDB v12, SQLite v17).
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import { SCHEMA_VERSION } from './sqliteMigrations';
import type { IStorage, PendingMutation, StoredMessage } from './types';
import { encryptData } from '../encryption';
import { toMessagePayload } from './messagePayload';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
let n = 0;

/** A real `node:sqlite` engine behind the plugin's `execute`/`select`. */
function sqliteEngine() {
  // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
  // browser one, and Vite refuses to bundle a Node built-in named in an import.
  const engine = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');
  /** The plugin binds `$n`; `?n` is the same positional parameter for `node:sqlite`. */
  const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
  const db = {
    execute: async (sql: string, params: unknown[] = []) => {
      const result = engine.prepare(positional(sql)).run(...(params as never[]));
      return { rowsAffected: Number(result.changes) };
    },
    select: async (sql: string, params: unknown[] = []) =>
      engine.prepare(positional(sql)).all(...(params as never[])),
    close: async () => undefined,
  };
  return { engine, db };
}

async function sqliteOver(db: unknown): Promise<SqliteStorage> {
  vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
  const storage = new SqliteStorage(`pending-${n++}`);
  await storage.init();
  return storage;
}

async function openSqlite(): Promise<IStorage> {
  return sqliteOver(sqliteEngine().db);
}

async function openIdb(): Promise<IStorage> {
  const storage = new IndexedDbStorage(`pending-${Date.now()}-${n++}`);
  await storage.init();
  return storage;
}

afterEach(() => {
  vi.doUnmock('@tauri-apps/plugin-sql');
});

const backends: Array<[string, () => Promise<IStorage>]> = [
  ['IndexedDbStorage', openIdb],
  ['SqliteStorage', openSqlite],
];

const entry = (over: Partial<PendingMutation> = {}): PendingMutation => ({
  conversationId: 'conv',
  messageId: 'm1',
  sender: 'alice',
  kind: 'delete',
  slot: '',
  rank: 0,
  at: 1_000,
  ...over,
});

const body = (id: string, content = 'the body'): StoredMessage => ({
  id,
  conversationId: 'conv',
  senderId: 'alice',
  content,
  timestamp: 1_000,
});

describe.each(backends)('%s - pending mutations', (_name, open) => {
  it('keeps an entry sealed and reads it back by message id, and only those asked', async () => {
    const storage = await open();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.putPendingMutation(
      entry({ kind: 'edit', rank: 5, text: 'secret edit' }),
      10,
      KEY
    );
    await storage.putPendingMutation(entry({ messageId: 'm2' }), 10, KEY);

    const read = await storage.getPendingMutations('conv', ['m1'], KEY);
    expect(read.entries).toEqual([entry({ kind: 'edit', rank: 5, text: 'secret edit' })]);
    expect(read.unreadable).toBe(0);
    expect((await storage.getPendingMutations('other', ['m1'], KEY)).entries).toEqual([]);
  });

  it('needs no conversation row - an entry may come before the conversation reaches the store', async () => {
    const storage = await open();
    const write = await storage.putPendingMutation(entry(), 10, KEY);
    expect(write).toEqual({ written: true, evicted: 0 });
  });

  it('keeps the larger rank under one key, the first on a tie - decided in the write', async () => {
    const storage = await open();
    const edit = (rank: number, text: string) => entry({ kind: 'edit', rank, text });
    expect((await storage.putPendingMutation(edit(5, 'five'), 10, KEY)).written).toBe(true);
    expect((await storage.putPendingMutation(edit(3, 'three'), 10, KEY)).written).toBe(false);
    expect((await storage.putPendingMutation(edit(5, 'tie'), 10, KEY)).written).toBe(false);
    expect((await storage.putPendingMutation(edit(9, 'nine'), 10, KEY)).written).toBe(true);
    const read = await storage.getPendingMutations('conv', ['m1'], KEY);
    expect(read.entries.map((e) => e.text)).toEqual(['nine']);
  });

  it('keeps one entry per sender and kind, so another sender never displaces the author', async () => {
    const storage = await open();
    await storage.putPendingMutation(entry({ sender: 'mallory' }), 10, KEY);
    await storage.putPendingMutation(entry({ sender: 'alice' }), 10, KEY);
    await storage.putPendingMutation(
      entry({ sender: 'mallory', kind: 'edit', rank: 9e15, text: 'far future' }),
      10,
      KEY
    );
    await storage.putPendingMutation(
      entry({ sender: 'alice', kind: 'edit', rank: 5, text: 'mine' }),
      10,
      KEY
    );
    const read = await storage.getPendingMutations('conv', ['m1'], KEY);
    expect(read.entries).toHaveLength(4);
  });

  it('evicts the OLDEST entries past the cap, by count, and says how many', async () => {
    const storage = await open();
    for (let i = 0; i < 3; i++) {
      await storage.putPendingMutation(entry({ messageId: `m${i}`, at: 100 + i }), 3, KEY);
    }
    const fourth = await storage.putPendingMutation(entry({ messageId: 'm9', at: 50 }), 3, KEY);
    expect(fourth).toEqual({ written: true, evicted: 1 });
    // The oldest by the frame's server time went - here the one just written.
    const left = await storage.getPendingMutations('conv', ['m0', 'm1', 'm2', 'm9'], KEY);
    expect(left.entries.map((e) => e.messageId).sort()).toEqual(['m0', 'm1', 'm2']);
    const fifth = await storage.putPendingMutation(entry({ messageId: 'm7', at: 500 }), 3, KEY);
    expect(fifth.evicted).toBe(1);
    const after = await storage.getPendingMutations('conv', ['m0', 'm1', 'm2', 'm7'], KEY);
    expect(after.entries.map((e) => e.messageId).sort()).toEqual(['m1', 'm2', 'm7']);
  });

  it('removes an entry only at the rank it was read at', async () => {
    const storage = await open();
    const old = entry({ kind: 'reaction', slot: '👍', rank: 1 });
    await storage.putPendingMutation(old, 10, KEY);
    await storage.putPendingMutation({ ...old, rank: 2, removed: true }, 10, KEY);
    await storage.deletePendingMutations([old]);
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toHaveLength(1);
    await storage.deletePendingMutations([{ ...old, rank: 2 }]);
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toHaveLength(0);
  });

  it('never opens an entry sealed under another key - it is reported, not applied', async () => {
    const storage = await open();
    await storage.putPendingMutation(entry(), 10, OTHER_KEY);
    expect(await storage.getPendingMutations('conv', ['m1'], KEY)).toEqual({
      entries: [],
      unreadable: 1,
    });
  });

  it('goes with its conversation', async () => {
    const storage = await open();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.putPendingMutation(entry(), 10, KEY);
    await storage.deleteConversation('conv');
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toEqual([]);
  });
});

describe.each(backends)('%s - saveMessagesIfAbsent', (_name, open) => {
  it('writes only where no row stands and names what it wrote', async () => {
    const storage = await open();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage({ ...body('m1'), isDeleted: true, content: 'deleted' }, KEY);

    const written = await storage.saveMessagesIfAbsent([body('m1'), body('m2')], KEY);

    expect([...written]).toEqual(['m2']);
    expect(await storage.getMessage('m1', KEY)).toMatchObject({ isDeleted: true });
    expect(await storage.getMessage('m2', KEY)).toMatchObject({ content: 'the body' });
  });

  it('never writes over a row this device cannot open', async () => {
    const storage = await open();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1', 'sealed elsewhere'), OTHER_KEY);

    expect((await storage.saveMessagesIfAbsent([body('m1')], KEY)).size).toBe(0);
    expect(await storage.getMessage('m1', OTHER_KEY)).toMatchObject({
      content: 'sealed elsewhere',
    });
  });
});

describe('the upgrade of a database the previous build left', () => {
  it('IndexedDB v12 -> v13 adds the store and keeps every message', async () => {
    const userId = `v12-${Date.now()}-${n++}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`CanariDB_${userId}`, 12);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('byConversation', 'conversationId', { unique: false });
        store.createIndex('byConversationTime', ['conversationId', 'timestamp'], {
          unique: false,
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const row = {
      id: 'm1',
      conversationId: 'conv',
      timestamp: 1_000,
      orderAt: 1_000,
      ...(await encryptData(toMessagePayload(body('m1')), KEY)),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const storage = new IndexedDbStorage(userId);
    await storage.init();

    expect(await storage.getMessage('m1', KEY)).toMatchObject({ content: 'the body' });
    expect((await storage.putPendingMutation(entry(), 10, KEY)).written).toBe(true);
  });

  it('SQLite v17 -> v18 creates the table, stamps 18 and keeps every message', async () => {
    const { engine, db } = sqliteEngine();
    const first = await sqliteOver(db);
    await first.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await first.saveMessage(body('m1'), KEY);
    // What a v17 build left: no `pending_mutations`, stamped 17.
    engine.exec('DROP TABLE pending_mutations; PRAGMA user_version = 17;');

    const upgraded = await sqliteOver(db);

    expect(SCHEMA_VERSION).toBe(18);
    expect(engine.prepare('PRAGMA user_version').get()).toEqual({ user_version: 18 });
    expect(await upgraded.getMessage('m1', KEY)).toMatchObject({ content: 'the body' });
    expect((await upgraded.putPendingMutation(entry(), 10, KEY)).written).toBe(true);
  });
});
