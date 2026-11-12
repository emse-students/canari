/**
 * LOCAL RETENTION IS THE DEVICE WINDOW (owner, 2026-11-11): a phone or desktop app keeps 5 years,
 * a browser 90 days. `deleteOldMessages()` with no argument collects at `deviceWindowMs()` on both
 * backends - SQLite (the native store) run for real against `node:sqlite`, IndexedDB (the browser
 * store) through `fake-indexeddb`. Before this, the collector deleted at 90 days everywhere while
 * the history protocol promised 5 years on native.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { IStorage, StoredMessage } from './types';

const runtime = vi.hoisted(() => ({ tauri: false }));
vi.mock('$lib/utils/openExternal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => runtime.tauri,
}));

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DAY = 86_400_000;
let n = 0;

const message = (id: string, ageDays: number): StoredMessage => ({
  id,
  conversationId: 'conv',
  senderId: 'alice',
  content: id,
  timestamp: Date.now() - ageDays * DAY,
});

/** A real `node:sqlite` engine behind the plugin's `execute`/`select`. */
async function sqliteStorage(): Promise<IStorage> {
  const engine = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');
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
  vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
  const storage = new SqliteStorage(`retention-${n++}`);
  await storage.init();
  await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
  return storage;
}

async function idbStorage(): Promise<IStorage> {
  const storage = new IndexedDbStorage(`retention-${Date.now()}-${n++}`);
  await storage.init();
  await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
  return storage;
}

async function kept(storage: IStorage, ids: string[]): Promise<string[]> {
  const all = await storage.getMessages('conv', KEY);
  return all
    .map((m) => m.id)
    .filter((id) => ids.includes(id))
    .sort();
}

afterEach(() => {
  runtime.tauri = false;
});

describe('deleteOldMessages() collects at the device window', () => {
  it('on a native device (SQLite) keeps a 1-year-old message and drops a 6-year-old one', async () => {
    runtime.tauri = true;
    const storage = await sqliteStorage();
    for (const m of [message('year', 365), message('recent', 1), message('ancient', 6 * 365)]) {
      await storage.saveMessage(m, KEY);
    }

    expect(await storage.deleteOldMessages()).toBe(1);
    expect(await kept(storage, ['year', 'recent', 'ancient'])).toEqual(['recent', 'year']);
  });

  it('in a browser (IndexedDB) drops a 91-day-old message and keeps an 89-day-old one', async () => {
    runtime.tauri = false;
    const storage = await idbStorage();
    for (const m of [message('old', 91), message('inside', 89)]) {
      await storage.saveMessage(m, KEY);
    }

    expect(await storage.deleteOldMessages()).toBe(1);
    expect(await kept(storage, ['old', 'inside'])).toEqual(['inside']);
  });

  it('CONTROL: the same 1-year-old message is dropped at the browser window', async () => {
    runtime.tauri = false;
    const storage = await sqliteStorage();
    await storage.saveMessage(message('year', 365), KEY);

    expect(await storage.deleteOldMessages()).toBe(1);
    expect(await kept(storage, ['year'])).toEqual([]);
  });

  it('still honours an explicit age when a caller names one', async () => {
    const storage = await idbStorage();
    await storage.saveMessage(message('two-days', 2), KEY);
    expect(await storage.deleteOldMessages(DAY)).toBe(1);
  });
});
