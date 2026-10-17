import { synchronizeWithPrerequisites, SYNCHRONIZE_EXTENSIONS } from './synchronize-prerequisites';

describe('synchronizeWithPrerequisites', () => {
  it('creates every extension BEFORE building the schema', async () => {
    const calls: string[] = [];
    await synchronizeWithPrerequisites({
      query: async (sql: string) => {
        calls.push(sql);
      },
      synchronize: async () => {
        calls.push('synchronize');
      },
    });

    expect(calls).toEqual([
      ...SYNCHRONIZE_EXTENSIONS.map((e) => `CREATE EXTENSION IF NOT EXISTS ${e} SCHEMA public`),
      'synchronize',
    ]);
    // The bookings exclusion is what needs it (migration 087).
    expect(SYNCHRONIZE_EXTENSIONS).toContain('btree_gist');
  });

  it('does not synchronise when an extension cannot be created', async () => {
    const synchronize = jest.fn();
    await expect(
      synchronizeWithPrerequisites({
        query: () => Promise.reject(new Error('permission denied to create extension')),
        synchronize,
      })
    ).rejects.toThrow('permission denied');
    expect(synchronize).not.toHaveBeenCalled();
  });
});
