/**
 * `saveMessageIfAbsent` writes a row only where none stands, decided by the store's own key
 * constraint in the same statement as the write - never by a read before it.
 *
 * Its caller is a deletion that arrived before its message (`deletedBeforeArrival`): the tombstone
 * must not overwrite a row this device holds but cannot read, which `getMessage` reports as `null`
 * exactly like an absent one.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { StoredMessage } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
let n = 0;

const body: StoredMessage = {
  id: 'm1',
  conversationId: 'conv',
  senderId: 'peer',
  content: 'the body',
  timestamp: 1_000,
};
const tombstone: StoredMessage = {
  id: 'm1',
  conversationId: 'conv',
  senderId: 'peer',
  content: 'deleted',
  timestamp: 9_000,
  isDeleted: true,
  deletedBeforeArrival: true,
};

describe('IndexedDbStorage.saveMessageIfAbsent', () => {
  async function openStore() {
    const storage = new IndexedDbStorage(`if-absent-${n++}`);
    await storage.init();
    return storage;
  }

  it('writes where no row stands, and the flag reads back', async () => {
    const storage = await openStore();

    expect(await storage.saveMessageIfAbsent(tombstone, KEY)).toBe(true);
    expect(await storage.getMessage('m1', KEY)).toMatchObject({
      isDeleted: true,
      deletedBeforeArrival: true,
    });
    await storage.close();
  });

  it('leaves a held row alone - one it cannot read included', async () => {
    const storage = await openStore();
    // Sealed under another device key: `getMessage` reads it as null, like an absent row.
    await storage.saveMessage(body, OTHER_KEY);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await storage.getMessage('m1', KEY)).toBeNull();

    expect(await storage.saveMessageIfAbsent(tombstone, KEY)).toBe(false);
    expect(await storage.getMessage('m1', OTHER_KEY)).toMatchObject({ content: 'the body' });
    await storage.close();
  });
});

describe('SqliteStorage.saveMessageIfAbsent', () => {
  // Reached through `process.getBuiltinModule` for the reason `messagesPage.test.ts` gives.
  const newEngine = () => new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');

  async function initialisedSqlite() {
    const engine = newEngine();
    const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
    const db = {
      // The plugin answers an execute with the rows it changed, as `node:sqlite` does.
      execute: async (sql: string, params: unknown[] = []) => {
        const result = engine.prepare(positional(sql)).run(...(params as never[]));
        return { rowsAffected: Number(result.changes) };
      },
      select: async (sql: string, params: unknown[] = []) =>
        engine.prepare(positional(sql)).all(...(params as never[])),
      close: async () => undefined,
    };
    vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
    const storage = new SqliteStorage(`sqlite-if-absent-${n++}`);
    await storage.init();
    // A message row names its conversation (foreign key), as every row a device writes does.
    engine.exec("INSERT INTO conversations (id, name) VALUES ('conv', 'Conversation')");
    return storage;
  }

  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-sql');
  });

  it('writes where no row stands, and never replaces one that does', async () => {
    const storage = await initialisedSqlite();

    expect(await storage.saveMessageIfAbsent(tombstone, KEY)).toBe(true);
    expect(await storage.getMessage('m1', KEY)).toMatchObject({ deletedBeforeArrival: true });

    expect(await storage.saveMessageIfAbsent({ ...body }, KEY)).toBe(false);
    expect(await storage.getMessage('m1', KEY)).toMatchObject({ content: 'deleted' });
  });
});
