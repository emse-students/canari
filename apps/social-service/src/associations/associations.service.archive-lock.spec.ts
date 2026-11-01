import { AssociationsService } from './associations.service';
import { Association } from './entities/association.entity';

/**
 * ARCHIVING IS ORDERED AGAINST A PURCHASE ON THE ASSOCIATION ROW.
 *
 * `ProductsService.decidePurchase` reads the association FOR SHARE under the buyer's lock, so the
 * archive must take the row FOR UPDATE (`pessimistic_write`) INSIDE a transaction, before it writes:
 * a checkout already deciding commits first, and one deciding afterwards reads `archived` committed.
 * A plain `update` would let the two interleave, so the order of the calls and the lock mode are
 * what is pinned, not just that a write happened.
 */
function makeService() {
  const calls: string[] = [];
  const manager = {
    findOne: jest.fn(async (_entity: unknown, _opts: unknown) => {
      calls.push('lock');
      return { id: 'asso-1' };
    }),
    update: jest.fn(async () => {
      calls.push('write');
    }),
  };
  const assoRepo = {
    manager: {
      transaction: jest.fn(async (cb: (m: typeof manager) => Promise<unknown>) => {
        calls.push('begin');
        const out = await cb(manager);
        calls.push('commit');
        return out;
      }),
    },
    update: jest.fn(async () => {
      calls.push('plain-write');
    }),
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
    { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
  );
  Object.assign(service, {
    findById: jest.fn(async () => ({ id: 'asso-1', slug: 'bde' })),
    invalidatePostListCaches: jest.fn(async () => undefined),
  });
  return { service, assoRepo, manager, calls };
}

describe('AssociationsService.update - archiving', () => {
  it('locks the association row FOR UPDATE inside a transaction, then writes', async () => {
    const { service, assoRepo, manager, calls } = makeService();

    await service.update('asso-1', { archived: true } as never);

    expect(assoRepo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(manager.findOne).toHaveBeenCalledWith(Association, {
      where: { id: 'asso-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.update).toHaveBeenCalledWith(Association, 'asso-1', { archived: true });
    expect(calls).toEqual(['begin', 'lock', 'write', 'commit']);
    expect(assoRepo.update).not.toHaveBeenCalled();
  });

  it('CONTROL: an edit that does not touch archived takes no lock and no transaction', async () => {
    const { service, assoRepo, manager } = makeService();

    await service.update('asso-1', { description: 'Hello' } as never);

    expect(assoRepo.update).toHaveBeenCalledTimes(1);
    expect(assoRepo.manager.transaction).not.toHaveBeenCalled();
    expect(manager.findOne).not.toHaveBeenCalled();
  });
});
