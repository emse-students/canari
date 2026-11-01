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
