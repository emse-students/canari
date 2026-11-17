/**
 * The Graine outbound count's compare-and-swap on the SQLite backend, run for real: `SqliteStorage`
 * over `node:sqlite` behind the plugin's `execute`/`select`, the same harness as
 * `localReadSeedStore.test.ts`. The swap is ONE `UPDATE ... WHERE sent_count = $n`, and its refusal
 * is read from `rowsAffected`, never from an exception - the half a double would get wrong silently
 * (channel-encryption, WP-30: the orderings of `reserveOutboundSlot`).
 */
import { SqliteStorage } from './sqlite';
import { StoreWriteRefusedError, type IStorage, type StoredGraineSession } from './types';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
let n = 0;

/** A real `node:sqlite` engine behind the plugin's `execute`/`select`. */
async function sqlite(): Promise<IStorage> {
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
  vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
  const storage = new SqliteStorage(`graine-cas-${n++}`);
  await storage.init();
  return storage;
}

function session(over: Partial<StoredGraineSession> = {}): StoredGraineSession {
  return {
    workspaceId: 'w1',
    channelId: 'c1',
    sessionId: 'sess-1',
    senderId: 'u1',
    seedB64: 'c2VlZC1vbmUtdGhpcnR5LXR3by1ieXRlcy0wMDAwMDA=',
    firstIndex: 0,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe('Graine sessions in SQLite - the outbound count is written by compare-and-swap', () => {
  it('lands only while the stored count is the one it was read at; a moved count or a gone row is refused', async () => {
    const storage = await sqlite();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await storage.saveGraineSession(session({ sentCount: 5 }), KEY);

    // Read at 3, the row says 5: another writer reserved since. Refused, typed, nothing written.
    await expect(
      storage.saveGraineSession(session({ sentCount: 4 }), KEY, undefined, 3)
    ).rejects.toBeInstanceOf(StoreWriteRefusedError);
    expect((await storage.getGraineSession('sess-1', KEY))?.sentCount).toBe(5);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('moved from 3 to 5'));

    // A row gone since the read (a purge) is not brought back by the swap.
    await expect(
      storage.saveGraineSession(session({ sessionId: 'sess-2', sentCount: 1 }), KEY, undefined, 0)
    ).rejects.toBeInstanceOf(StoreWriteRefusedError);
    expect(await storage.getGraineSession('sess-2', KEY)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('moved from 0 to none'));

    // Read at the count the row still carries: written, the seed still opening.
    error.mockClear();
    await storage.saveGraineSession(session({ sentCount: 6 }), KEY, () => true, 5);
    expect(await storage.getGraineSession('sess-1', KEY)).toEqual(session({ sentCount: 6 }));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
