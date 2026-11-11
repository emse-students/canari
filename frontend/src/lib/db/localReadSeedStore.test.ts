/**
 * THE UPGRADE'S LOCAL READ SEED AT REST (`ConversationMeta.localReadSeed`), on BOTH backends:
 * IndexedDB through `fake-indexeddb`, SQLite through `SqliteStorage.init` run for real against
 * `node:sqlite`. Three states must survive every writer: `null` (a row an older build wrote, not
 * considered yet), `0` (considered, never seeded again - and every row this build inserts), and a
 * seed. A save that does not state the field keeps what the row holds. Map: chat.md, "A DM's
 * unread count is derived from its read point at every load (2026-11-11)".
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { ConversationMeta, IStorage } from './types';

let n = 0;

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

const seedOf = async (storage: IStorage, id: string) =>
  (await storage.getConversation(id))?.localReadSeed ?? null;

describe.each([
  ['SQLite', sqlite],
  ['IndexedDB', indexedDb],
])('the local read seed at rest (%s)', (_name, open) => {
  it('a row first written by this build is born 0 - new on this install, never seeded', async () => {
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

  it("an older build's row stays NOT CONSIDERED through a save that states nothing", async () => {
    const { storage } = await open();
    // What an older build left: a row with no seed at all (a backup import writes the same).
    await storage.mergeConversation(row('g1'));
    expect(await seedOf(storage, 'g1')).toBeNull();
    await storage.saveConversation(row('g1', { name: 'renamed' }));
    expect(await seedOf(storage, 'g1')).toBeNull();
  });
});

describe('the SQLite upgrade to v20', () => {
  it('leaves every existing row NULL, so the next load seeds each one once', async () => {
    const { storage, engine } = await sqlite();
    await storage.saveConversation(row('g1'));
    // What a v19 build left: no column, stamped 19.
    engine.exec('ALTER TABLE conversations DROP COLUMN local_read_seed; PRAGMA user_version = 19;');

    // The same engine, opened again by this build (the plugin mock is still the one over it).
    const upgraded = new SqliteStorage(`seed-${n++}`);
    await upgraded.init();

    expect(engine.prepare('PRAGMA user_version').get()).toEqual({ user_version: 20 });
    expect(await seedOf(upgraded, 'g1')).toBeNull();
  });
});
