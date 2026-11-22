/**
 * Every conversation column an upsert writes survives a save and a merge on SQLite.
 *
 * `saveConversation` is an `INSERT OR REPLACE`: a column its statement does not name is written NULL
 * on every save, silently. v16 added `server_read_watermarks` and v17 `started_at` in two pull
 * requests that each named only its own, so this reads both back through `SqliteStorage.init` run for
 * real against `node:sqlite` - the production schema and statements, not copies of them.
 */
import { SqliteStorage } from './sqlite';
import type { ConversationMeta } from './types';

let n = 0;

async function initialisedSqlite() {
  // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
  // browser one, and Vite refuses to bundle a Node built-in named in an import.
  const engine = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');
  /** The plugin binds `$n`; `?n` is the same positional parameter for `node:sqlite`. */
  const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
  const db = {
    execute: async (sql: string, params: unknown[] = []) => {
      engine.prepare(positional(sql)).run(...(params as never[]));
    },
    select: async (sql: string, params: unknown[] = []) =>
      engine.prepare(positional(sql)).all(...(params as never[])),
    close: async () => undefined,
  };
  vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
  const storage = new SqliteStorage(`sqlite-conversation-columns-${n++}`);
  await storage.init();
  return storage;
}

const STARTED_AT = 1_790_000_000_000;
const SERVER_MARKS = { alice: 1_790_000_100_000 };

const conversation = (id: string): ConversationMeta => ({
  id,
  name: 'Group',
  lifecycle: 'active',
  updatedAt: 1,
  serverReadWatermarks: SERVER_MARKS,
  startedAt: STARTED_AT,
});

describe('SqliteStorage - the conversation columns v16 and v17 added', () => {
  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-sql');
  });

  it('saveConversation writes both server_read_watermarks and started_at, and a re-save keeps both', async () => {
    const storage = await initialisedSqlite();
    await storage.saveConversation(conversation('g1'));
    // A second save is the REPLACE that would null whichever column its statement left out.
    await storage.saveConversation({ ...conversation('g1'), name: 'Renamed' });

    const row = await storage.getConversation('g1');
    expect(row?.name).toBe('Renamed');
    expect(row?.serverReadWatermarks).toEqual(SERVER_MARKS);
    expect(row?.startedAt).toBe(STARTED_AT);
  });

  it('mergeConversation writes both columns for a row it inserts', async () => {
    const storage = await initialisedSqlite();
    await storage.mergeConversation(conversation('g2'));

    const row = await storage.getConversation('g2');
    expect(row?.serverReadWatermarks).toEqual(SERVER_MARKS);
    expect(row?.startedAt).toBe(STARTED_AT);
  });
});

describe('SqliteStorage - the dated group name v21 added (`name_at`, groupName.ts)', () => {
  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-sql');
  });

  const NAME_AT = 1_790_000_200_000;

  it('a save and a merge keep the date beside the name, and a row with none reads none', async () => {
    const storage = await initialisedSqlite();
    await storage.saveConversation({ ...conversation('g3'), name: 'Les ROOTz', nameAt: NAME_AT });
    await storage.mergeConversation({ ...conversation('g4'), nameAt: NAME_AT });
    await storage.saveConversation(conversation('g5'));

    expect(await storage.getConversation('g3')).toMatchObject({
      name: 'Les ROOTz',
      nameAt: NAME_AT,
    });
    expect((await storage.getConversation('g4'))?.nameAt).toBe(NAME_AT);
    expect((await storage.getConversation('g5'))?.nameAt).toBeUndefined();
    await storage.saveConversation({
      ...conversation('g6'),
      nameAt: NAME_AT,
      nameSync: {
        serverCopy: { name: 'A', from: 'Old' },
        pending: { name: 'B', messageId: 'm1', sentAt: NAME_AT, over: { name: 'A', at: NAME_AT } },
      },
    });
    expect((await storage.getConversation('g6'))?.nameSync).toEqual({
      serverCopy: { name: 'A', from: 'Old' },
      pending: { name: 'B', messageId: 'm1', sentAt: NAME_AT, over: { name: 'A', at: NAME_AT } },
    });
    expect((await storage.getConversation('g5'))?.nameSync).toBeUndefined();
  });
});

describe("SqliteStorage - the dated name's rank v22 added, on a store already stamped 22", () => {
  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-sql');
    vi.restoreAllMocks();
  });

  const NAME_AT = 1_790_000_300_000;

  it('a store stamped 22 WITHOUT the rank columns (an earlier head of #3888) gets them on open, and saves', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const engine = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');
    const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
    const db = {
      execute: async (sql: string, params: unknown[] = []) => {
        engine.prepare(positional(sql)).run(...(params as never[]));
      },
      select: async (sql: string, params: unknown[] = []) =>
        engine.prepare(positional(sql)).all(...(params as never[])),
      close: async () => undefined,
    };
    vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
    await new SqliteStorage(`sqlite-rank-in-place-${n++}`).init();
    // What an earlier head left: stamped 22 with only the first rank column.
    engine.exec('ALTER TABLE conversations DROP COLUMN name_rename_at');
    engine.exec('ALTER TABLE conversations DROP COLUMN name_renamed_by');
    expect(engine.prepare('PRAGMA user_version').get()).toEqual({ user_version: 22 });

    const reopened = new SqliteStorage(`sqlite-rank-in-place-${n++}`);
    await reopened.init();
    await reopened.saveConversation({
      ...conversation('g7'),
      nameAt: NAME_AT,
      nameRenamedBy: 'alice',
    });
    await reopened.saveConversation({
      ...conversation('g8'),
      nameAt: NAME_AT,
      nameFromStatement: true,
      nameRenameAt: NAME_AT - 5,
    });
    expect(await reopened.getConversation('g7')).toMatchObject({ nameRenamedBy: 'alice' });
    expect(await reopened.getConversation('g8')).toMatchObject({
      nameFromStatement: true,
      nameRenameAt: NAME_AT - 5,
    });
  });
});

describe('SqliteStorage - the kind of "Mes notes"', () => {
  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-sql');
    vi.restoreAllMocks();
  });

  it('a self row keeps its kind through a save, a re-save and a merge; any other row has none', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const storage = await initialisedSqlite();
    await storage.saveConversation({ ...conversation('n1'), name: '', kind: 'self' });
    await storage.saveConversation({ ...conversation('n1'), name: '', kind: 'self', updatedAt: 2 });
    await storage.mergeConversation({ ...conversation('n2'), name: '', kind: 'self' });
    await storage.saveConversation(conversation('g1'));

    expect((await storage.getConversation('n1'))?.kind).toBe('self');
    expect((await storage.getConversation('n2'))?.kind).toBe('self');
    expect(await storage.getConversation('g1')).not.toHaveProperty('kind');
  });
});
