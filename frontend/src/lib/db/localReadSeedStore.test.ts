/**
 * THE UPGRADE'S LOCAL READ SEED AT REST (`ConversationMeta.localReadSeed`), on BOTH backends:
 * IndexedDB through `fake-indexeddb`, SQLite through `SqliteStorage.init` run for real against
 * `node:sqlite`. The seed is written by the STORE MIGRATION only (SQLite v20, IndexedDB 14), per
 * conversation, from that conversation's own stored rows, before the store can be written by anything
 * else; every other writer keeps it. Map: chat.md, "A DM's unread count is derived from its read
 * point at every load (2026-11-11)".
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage, seedLocalReadPointsInUpgrade } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { ConversationMeta, IStorage, StoredMessage } from './types';
import { derivedUnreadCount } from '$lib/utils/chat/readState';

let n = 0;
const ME = 'me';
const PEER = 'peer';
/** A valid AES-256 device key: the stores seal every row with it. */
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** A real `node:sqlite` engine behind the plugin's `execute`/`select`. */
function sqliteEngine() {
  // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
  // browser one, and Vite refuses to bundle a Node built-in named in an import.
  const engine = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');
  /** The plugin binds `$n`; `?n` is the same positional parameter for `node:sqlite`. */
  const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
  return {
    engine,
    db: {
      execute: async (sql: string, params: unknown[] = []) => {
        const result = engine.prepare(positional(sql)).run(...(params as never[]));
        return { rowsAffected: Number(result.changes) };
      },
      select: async (sql: string, params: unknown[] = []) =>
        engine.prepare(positional(sql)).all(...(params as never[])),
      close: async () => undefined,
    },
  };
}

async function sqlite(): Promise<{ storage: IStorage; engine: any }> {
  const { engine, db } = sqliteEngine();
  vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
  const storage = new SqliteStorage(`seed-${n++}`);
  await storage.init();
  return { storage, engine };
}

async function indexedDb(): Promise<{ storage: IStorage }> {
  const storage = new IndexedDbStorage(`seed-${n++}-${Math.random().toString(36).slice(2)}`);
  await storage.init();
  return { storage };
}

const row = (id: string, extra: Partial<ConversationMeta> = {}): ConversationMeta => ({
  id,
  name: id,
  lifecycle: 'active',
  updatedAt: 1,
  ...extra,
});

/** A row the server dated `at` (its author's phone stamped it 5 ms earlier); undated with no `at`. */
const message = (
  id: string,
  conversationId: string,
  stamp: number,
  at?: number
): StoredMessage => ({
  id,
  conversationId,
  senderId: PEER,
  content: '{}',
  timestamp: stamp,
  ...(at !== undefined ? { serverTimestamp: at } : {}),
});

const seedOf = async (storage: IStorage, id: string) =>
  (await storage.getConversation(id))?.localReadSeed ?? null;

/** The count a load derives for `id` from what the store holds, the way the restore does. */
async function storedCount(storage: IStorage, id: string): Promise<number> {
  const meta = await storage.getConversation(id);
  const rows = await storage.getMessagesPage(id, KEY, 50);
  return derivedUnreadCount(
    {
      messages: rows.map((r) => ({
        isOwn: r.senderId === ME,
        isSystem: false,
        senderId: r.senderId,
        timestamp: new Date(r.timestamp),
        serverTimestamp: r.serverTimestamp,
      })),
      readWatermarks: meta?.readWatermarks,
      serverReadWatermarks: meta?.serverReadWatermarks,
      localReadSeed: meta?.localReadSeed,
    },
    ME
  );
}

describe.each([
  ['SQLite', sqlite],
  ['IndexedDB', indexedDb],
])('the local read seed at rest (%s)', (_name, open) => {
  it('a row first written by this build is born 0 - nothing held before the upgrade', async () => {
    const { storage } = await open();
    await storage.saveConversation(row('g1'));
    expect(await seedOf(storage, 'g1')).toBe(0);
  });

  it('a save that states a seed writes it; one that states nothing keeps it', async () => {
    const { storage } = await open();
    await storage.saveConversation(row('g1', { localReadSeed: 5_000 }));
    await storage.saveConversation(row('g1', { name: 'renamed' }));
    expect(await seedOf(storage, 'g1')).toBe(5_000);
    expect((await storage.getConversation('g1'))?.name).toBe('renamed');
  });

  it('a message stored after the store opened counts, and moves no seed', async () => {
    const { storage } = await open();
    await storage.saveConversation(row('g1', { localReadSeed: 2_000 }));
    // What the push cache writes at any moment after open (`saveMessagesIfAbsent`).
    await storage.saveMessagesIfAbsent([message('late', 'g1', 2_995, 3_000)], KEY);
    expect(await seedOf(storage, 'g1')).toBe(2_000);
    expect(await storedCount(storage, 'g1')).toBe(1);
  });
});

describe('the SQLite upgrade to v20 writes every seed, per row, inside the migration', () => {
  /** A v19 file holding `msgs`, its conversation rows with no seed column, then upgraded. */
  async function upgradedFrom19(ids: string[], msgs: StoredMessage[], pendingIds: string[] = []) {
    const { storage, engine } = await sqlite();
    for (const id of ids) await storage.saveConversation(row(id));
    await storage.saveMessagesIfAbsent(msgs, KEY);
    for (const id of pendingIds) {
      engine.prepare('UPDATE messages SET order_pending = 1 WHERE id = ?').run(id);
    }
    // What a v19 build left: no column, stamped 19.
    engine.exec('ALTER TABLE conversations DROP COLUMN local_read_seed; PRAGMA user_version = 19;');
    // The same engine, opened again by this build (the plugin mock is still the one over it).
    const upgraded = new SqliteStorage(`seed-${n++}`);
    await upgraded.init();
    expect(engine.prepare('PRAGMA user_version').get()).toEqual({ user_version: 20 });
    return { storage: upgraded, engine };
  }

  it("seeds each row at ITS OWN newest server time: one row's newest never covers another's older message", async () => {
    const { storage } = await upgradedFrom19(
      ['a', 'b'],
      [
        message('a1', 'a', 995, 1_000),
        message('a2', 'a', 8_995, 9_000),
        message('b1', 'b', 4_995, 5_000),
      ]
    );
    expect(await seedOf(storage, 'a')).toBe(9_000);
    expect(await seedOf(storage, 'b')).toBe(5_000);
    // A message 'b' receives after the upgrade, older than 'a''s newest, counts in 'b'.
    await storage.saveMessagesIfAbsent([message('b2', 'b', 5_995, 6_000)], KEY);
    expect(await storedCount(storage, 'b')).toBe(1);
    expect(await storedCount(storage, 'a')).toBe(0);
  });

  it('skips undated and provisional rows (an author clock), and gives a row with none 0', async () => {
    const { storage } = await upgradedFrom19(
      ['dated', 'undated', 'empty'],
      [
        message('d1', 'dated', 995, 1_000),
        message('d2', 'dated', 99_000_000), // undated: the author's phone running fast
        message('p1', 'dated', 50_000, 50_000), // provisional, flagged below
        message('u1', 'undated', 4_000),
      ],
      ['p1']
    );
    expect(await seedOf(storage, 'dated')).toBe(1_000);
    expect(await seedOf(storage, 'undated')).toBe(0);
    expect(await seedOf(storage, 'empty')).toBe(0);
  });

  it('run twice is a no-op: the fill writes only what is still NULL', async () => {
    const { storage, engine } = await upgradedFrom19(['a'], [message('a1', 'a', 995, 1_000)]);
    // A crash before the stamp: the step runs again, over a newer message stored meanwhile.
    await storage.saveMessagesIfAbsent([message('a2', 'a', 2_995, 3_000)], KEY);
    engine.exec('PRAGMA user_version = 19;');
    const again = new SqliteStorage(`seed-${n++}`);
    await again.init();
    expect(await seedOf(again, 'a')).toBe(1_000);
    expect(await storedCount(again, 'a')).toBe(1);
  });
});

describe('the IndexedDB upgrade to 14 writes every seed, per row, inside the versionchange transaction', () => {
  /** A raw store at version 1 holding `conversations` and `messages` rows as a v13 build left them. */
  async function v13Store(
    name: string,
    conversations: Array<Record<string, unknown>>,
    messages: Array<Record<string, unknown>>
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const convs = db.createObjectStore('conversations', { keyPath: 'id' });
        const msgs = db.createObjectStore('messages', { keyPath: 'id' });
        for (const c of conversations) convs.put(c);
        for (const m of messages) msgs.put(m);
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Opens `name` at `version`, running the seed step in its versionchange transaction. */
  function upgrade(name: string, version: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => seedLocalReadPointsInUpgrade(req.transaction!);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const all = (db: IDBDatabase): Promise<Record<string, any>> =>
    new Promise((resolve, reject) => {
      const req = db.transaction('conversations').objectStore('conversations').getAll();
      req.onsuccess = () =>
        resolve(Object.fromEntries(req.result.map((c: any) => [c.id, c.localReadSeed])));
      req.onerror = () => reject(req.error);
    });

  const stored = (
    id: string,
    conversationId: string,
    timestamp: number,
    orderAt: number,
    pending = false
  ) => ({
    id,
    conversationId,
    timestamp,
    orderAt,
    ...(pending ? { orderPending: 1 } : {}),
  });

  it('per row, dated rows only, 0 for a row with none, and a write queued during the upgrade lands after it', async () => {
    const name = `idb-seed-${n++}`;
    await v13Store(
      name,
      [{ id: 'a' }, { id: 'b' }, { id: 'undated' }, { id: 'empty' }],
      [
        stored('a1', 'a', 995, 1_000),
        stored('a2', 'a', 8_995, 9_000),
        stored('b1', 'b', 4_995, 5_000),
        stored('u1', 'undated', 99_000_000, 99_000_000),
        stored('p1', 'b', 70_000, 70_000, true),
      ]
    );
    const upgrading = upgrade(name, 2);
    // A second connection asked for while the upgrade runs - what a push-cache write is: it waits
    // for the versionchange transaction to commit, so what it writes is never covered.
    const late = new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 2);
      req.onsuccess = () => {
        const tx = req.result.transaction('messages', 'readwrite');
        tx.objectStore('messages').put(stored('b2', 'b', 5_995, 6_000));
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    const db = await upgrading;
    await late;
    expect(await all(db)).toEqual({ a: 9_000, b: 5_000, undated: 0, empty: 0 });
    db.close();
  });

  it('run twice is a no-op: a row already holding a number keeps it', async () => {
    const name = `idb-seed-${n++}`;
    await v13Store(name, [{ id: 'a' }], [stored('a1', 'a', 995, 1_000)]);
    (await upgrade(name, 2)).close();
    // A newer dated row stored meanwhile, then the step again.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 2);
      req.onsuccess = () => {
        const tx = req.result.transaction('messages', 'readwrite');
        tx.objectStore('messages').put(stored('a2', 'a', 2_995, 3_000));
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    const db = await upgrade(name, 3);
    expect(await all(db)).toEqual({ a: 1_000 });
    db.close();
  });
});
