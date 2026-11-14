import { spaceContact, type ContactQuery } from './booking-contact';

const VIEWER = 'v'.repeat(64);
const FIRST = 'a'.repeat(64);
const SECOND = 'b'.repeat(64);
const OWNER = 'c'.repeat(64);

const row = (userId: string, firstName: string) => ({
  userId,
  displayName: null,
  firstName,
  lastName: 'Test',
});

/** A fake database: the holders as the SQL's ORDER BY returns them, and the block rows. */
function fake(holders: Record<string, unknown>[], blocks: Record<string, unknown>[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query: ContactQuery = (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('user_blocks')) return Promise.resolve(blocks);
    return Promise.resolve(holders);
  };
  return { query, calls };
}

describe('spaceContact', () => {
  it('names the owner of a personal space', async () => {
    const { query, calls } = fake([row(OWNER, 'Owner')]);
    const c = await spaceContact(query, { associationId: null, ownerId: OWNER }, VIEWER);
    expect(c).toEqual({ userId: OWNER, displayName: 'Owner Test' });
    expect(calls[0].params).toEqual([OWNER]);
  });

  it('names the first holder of MANAGE_BOOKINGS, in the roster order the SQL gives', async () => {
    const { query, calls } = fake([row(FIRST, 'First'), row(SECOND, 'Second')]);
    const c = await spaceContact(query, { associationId: 'asso', ownerId: OWNER }, VIEWER);
    expect(c?.userId).toBe(FIRST);
    expect(calls[0].sql).toContain('ORDER BY m."sortOrder" ASC, m."createdAt" ASC, m."userId" ASC');
    expect(calls[0].params).toEqual(['asso', 1 << 11]);
  });

  it('shows nobody when no member holds the right', async () => {
    const { query } = fake([]);
    expect(await spaceContact(query, { associationId: 'asso', ownerId: OWNER }, VIEWER)).toBeNull();
  });

  it('skips a candidate who blocked the viewer, or was blocked by them', async () => {
    const { query } = fake(
      [row(FIRST, 'First'), row(SECOND, 'Second')],
      [{ blockerId: FIRST, blockedId: VIEWER }]
    );
    const c = await spaceContact(query, { associationId: 'asso', ownerId: OWNER }, VIEWER);
    expect(c?.userId).toBe(SECOND);
  });

  it('shows nobody when every candidate is blocked with the viewer', async () => {
    const { query } = fake([row(FIRST, 'First')], [{ blockerId: VIEWER, blockedId: FIRST }]);
    expect(await spaceContact(query, { associationId: 'asso', ownerId: OWNER }, VIEWER)).toBeNull();
  });

  it('skips an account with no name at all', async () => {
    const { query } = fake([{ userId: FIRST, displayName: null, firstName: null, lastName: null }]);
    expect(await spaceContact(query, { associationId: 'asso', ownerId: OWNER }, VIEWER)).toBeNull();
  });

  it('returns the viewer themself when they are first (the screen hides the button)', async () => {
    const { query } = fake([row(VIEWER, 'Me'), row(SECOND, 'Second')]);
    const c = await spaceContact(query, { associationId: 'asso', ownerId: OWNER }, VIEWER);
    expect(c?.userId).toBe(VIEWER);
  });
});
