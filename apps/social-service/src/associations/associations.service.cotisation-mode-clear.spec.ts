import { ConflictException } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import { Association } from './entities/association.entity';
import { COTISATION_MODE_IN_USE } from './members-only-gate';

/**
 * CLEARING A COTISATION MODE IS REFUSED WHILE A MEMBERS-ONLY ROW STILL NEEDS IT.
 *
 * With no mode `isBuyerCotisant` is false for everyone, so an ACTIVE members-only product or card
 * would stay listed and be refused to all. The clear takes the association row FOR UPDATE, counts
 * the rows under that lock and writes nothing when any exists; an association holding none clears
 * untouched (CONTROL). The overlap with a members-only save is ordered by the same row lock
 * (`lockAndAssertMembersOnlyGateable`, FOR SHARE) - its order is pinned in the products and
 * partnerships specs.
 */
function makeService(rows: { products: unknown[]; cards: unknown[]; mode: string | null }) {
  const calls: string[] = [];
  const manager = {
    findOne: jest.fn(async (_entity: unknown, opts: { lock?: { mode: string } }) => {
      calls.push(`lock:${opts.lock?.mode}`);
      return { id: 'asso-1', cotisationMode: rows.mode };
    }),
    query: jest.fn(async (sql: string) => {
      calls.push('count');
      return sql.includes('association_products') ? rows.products : rows.cards;
    }),
    update: jest.fn(async () => {
      calls.push('write');
    }),
  };
  const assoRepo = {
    manager: {
      transaction: jest.fn(async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager)),
    },
    update: jest.fn(),
  };
  const service = new AssociationsService(
    assoRepo as never,
    undefined as never, // memberRepo
    undefined as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never, // userTagService
    { enabled: () => false, tell: async () => 0 } as never
  );
  Object.assign(service, {
    findById: jest.fn(async () => ({ id: 'asso-1', slug: 'bde', cotisationMode: rows.mode })),
    invalidatePostListCaches: jest.fn(async () => undefined),
  });
  return { service, manager, calls };
}

describe('AssociationsService.update - clearing the cotisation mode', () => {
  it('refuses with 409 COTISATION_MODE_IN_USE, naming the rows, and writes nothing', async () => {
    const { service, manager, calls } = makeService({
      mode: 'dated',
      products: [{ id: 'p1', name: 'Cafe cotisants' }],
      cards: [{ id: 'c1', title: 'Reduction bar' }],
    });

    const err = await service
      .update('asso-1', { cotisationMode: null } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: COTISATION_MODE_IN_USE,
      products: [{ id: 'p1', name: 'Cafe cotisants' }],
      cards: [{ id: 'c1', title: 'Reduction bar' }],
    });
    expect(manager.update).not.toHaveBeenCalled();
    expect(calls).toEqual(['lock:pessimistic_write', 'count', 'count']);
  });

  it('refuses for a card alone', async () => {
    const { service } = makeService({
      mode: 'lifetime',
      products: [],
      cards: [{ id: 'c1', title: 'x' }],
    });
    await expect(
      service.update('asso-1', { cotisationMode: null } as never)
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('CONTROL: an association holding no members-only row clears, after taking the lock', async () => {
    const { service, manager, calls } = makeService({ mode: 'dated', products: [], cards: [] });

    await service.update('asso-1', { cotisationMode: null } as never);

    expect(manager.update).toHaveBeenCalledWith(
      Association,
      'asso-1',
      expect.objectContaining({ cotisationMode: null })
    );
    expect(calls).toEqual(['lock:pessimistic_write', 'count', 'count', 'write']);
  });

  it('CONTROL: a clear of a mode that is already null counts nothing (no transition)', async () => {
    const { service, manager, calls } = makeService({
      mode: null,
      products: [{ id: 'p1', name: 'legacy' }],
      cards: [],
    });

    await service.update('asso-1', { cotisationMode: null } as never);

    expect(manager.query).not.toHaveBeenCalled();
    expect(calls).toEqual(['lock:pessimistic_write', 'write']);
  });

  it('CONTROL: setting a mode takes the ordinary path, no count', async () => {
    const { service, manager } = makeService({ mode: null, products: [{}], cards: [] });
    await service.update('asso-1', { cotisationMode: 'dated' } as never);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
