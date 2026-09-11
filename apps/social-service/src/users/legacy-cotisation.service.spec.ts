import { Repository } from 'typeorm';
import { LegacyCotisationService } from './legacy-cotisation.service';
import { LegacyCotisation } from './entities/legacy-cotisation.entity';
import { UserTagService } from './user-tag.service';

describe('LegacyCotisationService.claimFor', () => {
  function makeService(rows: Partial<LegacyCotisation>[] = []) {
    const repo: any = {
      find: jest.fn(() => Promise.resolve(rows)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const userTags: any = {
      holdsAnyCotisation: jest.fn(() => Promise.resolve(false)),
      grantCotisant: jest.fn(() => Promise.resolve({})),
    };
    const service = new LegacyCotisationService(
      repo as unknown as Repository<LegacyCotisation>,
      userTags as unknown as UserTagService
    );
    return { service, repo, userTags };
  }

  const alice = { userId: 'user1', firstName: 'Alice', lastName: 'Martin', promo: 2025 };

  const staged = (overrides: Partial<LegacyCotisation> = {}): Partial<LegacyCotisation> => ({
    id: 'row1',
    matchKey: 'martin|alice|2025',
    sourceLabel: 'MARTIN Alice (1A)',
    associationId: 'assoc-bde',
    variantKey: null,
    sourceBatch: 'bde-legacy-2026-09',
    claimedByUserId: null,
    claimedAt: null,
    metadata: {},
    ...overrides,
  });

  it('grants a waiting cotisation and closes the row', async () => {
    const { service, repo, userTags } = makeService([staged()]);

    const outcome = await service.claimFor(alice);

    expect(userTags.grantCotisant).toHaveBeenCalledWith(
      'assoc-bde',
      'user1',
      'system:legacy-import',
      null,
      expect.objectContaining({ legacy: expect.objectContaining({ batch: 'bde-legacy-2026-09' }) })
    );
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'row1' }),
      expect.objectContaining({ claimedByUserId: 'user1' })
    );
    expect(outcome).toEqual({ granted: 1, alreadyHeld: 0, failed: 0, conflicts: 0 });
  });

  it('never downgrades a cotisation already held: the tier bought in Canari wins', async () => {
    // grantCotisant revokes sibling tiers in the same transaction, so granting the legacy tier to
    // someone who bought another one would take away what they paid for.
    const { service, userTags } = makeService([staged({ variantKey: 'avec-alcool' })]);
    userTags.holdsAnyCotisation.mockResolvedValue(true);

    const outcome = await service.claimFor(alice);

    expect(userTags.grantCotisant).not.toHaveBeenCalled();
    expect(outcome).toEqual({ granted: 0, alreadyHeld: 1, failed: 0, conflicts: 0 });
  });

  it('closes the row so the claim terminates on durable state, not on a second sign-in', async () => {
    const { service, repo, userTags } = makeService([staged({ claimedByUserId: 'user1' })]);

    const outcome = await service.claimFor(alice);

    expect(userTags.grantCotisant).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ granted: 0, alreadyHeld: 0, failed: 0, conflicts: 0 });
  });

  it('leaves the row pending when the grant throws, so the next sign-in retries it', async () => {
    const { service, repo, userTags } = makeService([staged()]);
    userTags.grantCotisant.mockRejectedValue(new Error('association not found'));

    const outcome = await service.claimFor(alice);

    expect(repo.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ granted: 0, alreadyHeld: 0, failed: 1, conflicts: 0 });
  });

  it('reports a row another account already claimed instead of silently granting nothing', async () => {
    const { service, userTags } = makeService([staged({ claimedByUserId: 'someone-else' })]);

    const outcome = await service.claimFor(alice);

    expect(userTags.grantCotisant).not.toHaveBeenCalled();
    expect(outcome.conflicts).toBe(1);
  });

  it('does not look anything up for a user with no usable key', async () => {
    const { service, repo } = makeService([staged()]);

    const outcome = await service.claimFor({ ...alice, promo: null });

    expect(repo.find).not.toHaveBeenCalled();
    expect(outcome).toEqual({ granted: 0, alreadyHeld: 0, failed: 0, conflicts: 0 });
  });

  it('isolates rows: one failing association does not swallow the ones behind it', async () => {
    const { service, userTags } = makeService([
      staged({ id: 'row1', associationId: 'assoc-bde' }),
      staged({ id: 'row2', associationId: 'assoc-cercle', variantKey: 'avec-alcool' }),
    ]);
    userTags.grantCotisant.mockRejectedValueOnce(new Error('boom'));

    const outcome = await service.claimFor(alice);

    expect(userTags.grantCotisant).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ granted: 1, alreadyHeld: 0, failed: 1, conflicts: 0 });
  });
});

describe('LegacyCotisationService.listForAdmin', () => {
  /** One raw row as the driver hands it back: bigint and timestamp columns arrive as strings. */
  const rawRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'row1',
    sourceLabel: 'MARTIN Alice (1A)',
    matchKey: 'martin|alice|2025',
    associationId: 'assoc-bde',
    associationName: 'BDE',
    variantKey: null,
    sourceBatch: 'bde-legacy-2026-09',
    claimedByUserId: null,
    claimedAt: null,
    disposition: null,
    claimantFirstName: null,
    claimantLastName: null,
    claimantPromo: null,
    keyRowCount: '1',
    createdAt: '2026-09-11T10:00:00.000Z',
    ...overrides,
  });

  /** Routes each of the three concurrent queries by what it selects, so order cannot matter. */
  function makeService(rows: Record<string, unknown>[], total: number, tally = {}) {
    const query = jest.fn((sql: string, _params?: unknown[]) => {
      if (sql.includes('COUNT(*)::text AS count'))
        return Promise.resolve([{ count: String(total) }]);
      if (sql.includes('FILTER (WHERE')) {
        return Promise.resolve([{ pending: '0', claimed: '0', collisions: '0', ...tally }]);
      }
      return Promise.resolve(rows);
    });
    const repo: any = { manager: { query } };
    const service = new LegacyCotisationService(
      repo as unknown as Repository<LegacyCotisation>,
      {} as unknown as UserTagService
    );
    return { service, query };
  }

  it('normalizes the string columns the driver does not type', async () => {
    const { service } = makeService([rawRow({ keyRowCount: '2' })], 1);

    const page = await service.listForAdmin();

    expect(page.items[0].keyRowCount).toBe(2);
    expect(page.items[0].createdAt).toBeInstanceOf(Date);
    expect(page.items[0].claimedAt).toBeNull();
  });

  it('caps the page so a caller cannot dump every staged name in one request', async () => {
    const { service, query } = makeService([], 1400);

    await service.listForAdmin({ limit: 100000, offset: -5 });

    // The listing query is the only one taking limit/offset; $3=limit, $4=offset.
    const listCall = query.mock.calls.find((c) => String(c[0]).includes('LIMIT $3'));
    expect(listCall?.[1]).toEqual([null, 'all', 200, 0]);
  });

  it('groups the collisions tab by key, because a homonym is only readable next to its twin', async () => {
    const { service, query } = makeService([], 0);

    await service.listForAdmin({ status: 'collisions' });

    const listCall = query.mock.calls.find((c) => String(c[0]).includes('LIMIT $3'));
    expect(String(listCall?.[0])).toContain('ORDER BY r."matchKey" ASC');
  });

  it('counts the whole estate, not the filtered page: the tallies are the headline', async () => {
    const { service, query } = makeService([], 3, { pending: '1200', claimed: '230' });

    const page = await service.listForAdmin({ status: 'pending', search: 'martin' });

    expect(page.counts).toEqual({ pending: 1200, claimed: 230, collisions: 0 });
    const tallyCall = query.mock.calls.find((c) => String(c[0]).includes('FILTER (WHERE'));
    expect(tallyCall?.[1]).toBeUndefined(); // no search, no status - it spans the table
  });

  it('reports hasMore from the offset actually walked', async () => {
    const { service } = makeService([rawRow()], 120);

    expect((await service.listForAdmin({ offset: 100 })).hasMore).toBe(true);
    expect((await service.listForAdmin({ offset: 119 })).hasMore).toBe(false);
  });
});
