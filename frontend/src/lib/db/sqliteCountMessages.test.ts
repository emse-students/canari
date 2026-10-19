/**
 * `SqliteStorage.countMessages` answers "how many rows does this conversation hold" with ONE
 * `COUNT(*)` on the conversation's index, reading no row and decrypting nothing - the replay asks it
 * for every conversation on every cold start (see `history.cursorCheck.test.ts`).
 */
import { SqliteStorage } from './sqlite';

function storageAnswering(rows: unknown[]) {
  const storage = new SqliteStorage('u');
  const select = vi.fn().mockResolvedValue(rows);
  const execute = vi.fn();
  (storage as unknown as { db: unknown }).db = { execute, select };
  return { storage, select, execute };
}

describe('SqliteStorage.countMessages', () => {
  it('asks one COUNT for the conversation, bound as a parameter, and selects no row', async () => {
    const { storage, select, execute } = storageAnswering([{ n: 3 }]);

    expect(await storage.countMessages('group-1')).toBe(3);
    expect(select).toHaveBeenCalledTimes(1);
    const [sql, params] = select.mock.calls[0];
    expect(sql).toMatch(/^SELECT COUNT\(\*\) AS n FROM messages WHERE conversation_id = \$1$/);
    expect(params).toEqual(['group-1']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads a count the driver hands back as a string, and an empty answer as zero', async () => {
    expect(await storageAnswering([{ n: '12' }]).storage.countMessages('g')).toBe(12);
    expect(await storageAnswering([]).storage.countMessages('g')).toBe(0);
  });
});

/**
 * `countGraineSessionsForWorkspace` is what a history answer reads before claiming "I hold nothing"
 * (channel-encryption section 24): the ROWS, from the clear column, with no key - so a row the device
 * key cannot open still counts.
 */
describe('SqliteStorage.countGraineSessionsForWorkspace', () => {
  it('asks one COUNT on the clear community column, decrypting nothing', async () => {
    const { storage, select, execute } = storageAnswering([{ n: '2' }]);

    expect(await storage.countGraineSessionsForWorkspace('ws-1')).toBe(2);
    const [sql, params] = select.mock.calls[0];
    expect(sql).toMatch(/^SELECT COUNT\(\*\) AS n FROM graine WHERE workspace_id = \$1$/);
    expect(params).toEqual(['ws-1']);
    expect(execute).not.toHaveBeenCalled();
    expect(await storageAnswering([]).storage.countGraineSessionsForWorkspace('ws-1')).toBe(0);
  });
});
