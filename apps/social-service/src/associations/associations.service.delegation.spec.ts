import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import type { Association } from './entities/association.entity';

/**
 * Focused unit tests for the payment-delegation lifecycle. Only `assoRepo` and `redis` are
 * exercised, so the remaining constructor dependencies are passed as undefined.
 */
function makeService(seed: Record<string, Partial<Association>>) {
  const db = new Map<string, Association>();
  for (const [id, v] of Object.entries(seed))
    db.set(id, { id, name: id, slug: id, type: 'association', ...v } as Association);

  const filterByParent = (parentId: string) =>
    [...db.values()].filter((a) => a.paymentParentAssociationId === parentId);

  const assoRepo = {
    findOne: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(db.get(id) ?? null)
    ),
    find: jest.fn(
      ({
        where: { paymentParentAssociationId },
      }: {
        where: { paymentParentAssociationId: string };
      }) => Promise.resolve(filterByParent(paymentParentAssociationId))
    ),
    count: jest.fn(
      ({
        where: { paymentParentAssociationId },
      }: {
        where: { paymentParentAssociationId: string };
      }) => Promise.resolve(filterByParent(paymentParentAssociationId).length)
    ),
    update: jest.fn((id: string, patch: Partial<Association>) => {
      Object.assign(db.get(id), patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  // The transactional writes (request, cancel) read and write the same map through a manager.
  const manager = {
    findOne: jest.fn((_entity: unknown, { where: { id } }: { where: { id: string } }) =>
      Promise.resolve(db.get(id) ?? null)
    ),
    update: jest.fn((_entity: unknown, id: unknown, patch: Partial<Association>) => {
      if (typeof id === 'string' && db.has(id)) Object.assign(db.get(id)!, patch);
      return Promise.resolve({ affected: 0 });
    }),
  };
  Object.assign(assoRepo, {
    manager: { transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)) },
  });
  const redis = { deleteByPattern: jest.fn(() => Promise.resolve()) };

  // POSITIONAL, AND FOURTEEN LONG - so a constructor change silently shifts every argument after
  // the one it touched. The comments are the guard: keep them aligned with the parameter list in
  // `associations.service.ts`, and change them in the same commit that changes it.
  const service = new AssociationsService(
    assoRepo as never, // assoRepo
    undefined as never, // memberRepo
    undefined as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    redis as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never, // userTagService
    { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
  );
  return { service, db };
}

const ready = { lydiaOnboardingComplete: true, lydiaAccountId: 'vendor_x' };

describe('AssociationsService payment delegation by kind (owner, 2026-11-02)', () => {
  it('refuses a delegation request from an institution, typed', async () => {
    const { service, db } = makeService({ child: { type: 'institution' }, parent: { ...ready } });
    await expect(service.requestPaymentDelegation('child', 'parent')).rejects.toMatchObject({
      response: { code: 'ASSOCIATION_KIND_DOES_NOT_SELL' },
    });
    expect(db.get('child')!.paymentParentAssociationId).toBeUndefined();
  });

  it.each(['list', 'institution'] as const)(
    'refuses a %s as the RECEIVER of a delegation, typed',
    async (type) => {
      const { service } = makeService({ child: { type: 'list' }, parent: { ...ready, type } });
      await expect(service.requestPaymentDelegation('child', 'parent')).rejects.toMatchObject({
        response: {
          code: type === 'list' ? 'LIST_NO_OWN_LYDIA_ACCOUNT' : 'ASSOCIATION_KIND_DOES_NOT_SELL',
        },
      });
    }
  );

  it('refuses to enable a cotisation on a list with no approved delegate, typed', async () => {
    const { service, db } = makeService({ campaign: { type: 'list' } });
    // `findById` wants a UUID and a roster count; the kind is the only thing this case reads.
    jest.spyOn(service, 'findById').mockResolvedValue(db.get('campaign') as never);
    await expect(
      service.update('campaign', { cotisationEnabled: true } as never)
    ).rejects.toMatchObject({
      response: { code: 'LIST_DELEGATE_REQUIRED' },
    });
    expect(db.get('campaign')!.cotisationEnabled).toBeUndefined();
    // Disabling passes the guard: whatever it does next, it is not this refusal.
    const outcome = await service
      .update('campaign', { cotisationEnabled: false } as never)
      .catch((e: unknown) => e);
    expect(JSON.stringify(outcome)).not.toContain('LIST_DELEGATE_REQUIRED');
  });

  describe('who may accept on the receiver behalf (G7)', () => {
    const pendingChild = {
      type: 'list' as const,
      paymentParentAssociationId: 'parent',
      paymentDelegationStatus: 'pending' as const,
    };

    it('refuses a BDE member governing the receiver who is not its own shop manager', async () => {
      const { service, db } = makeService({ child: pendingChild, parent: { ...ready } });
      // The BDE tier is what `withoutGoverningBde` drops: the predicate is asked without it.
      const mayAct = jest
        .spyOn(service, 'mayAct')
        .mockImplementation(async (_u, _a, _f, opts) => !opts?.withoutGoverningBde);
      await expect(
        service.approvePaymentDelegation('parent', 'child', {
          userId: 'bde-star',
          isGlobalAdmin: false,
        })
      ).rejects.toMatchObject({ response: { code: 'DELEGATION_ACCEPT_RECEIVER_ONLY' } });
      expect(mayAct).toHaveBeenCalledWith('bde-star', 'parent', 256, {
        withoutGoverningBde: true,
      });
      expect(db.get('child')!.paymentDelegationStatus).toBe('pending');
    });
  });
});

describe('AssociationsService - the bitmask written for a member of a list', () => {
  const MEMBERS = 4; // MANAGE_MEMBERS
  const FORMS = 16; // MANAGE_FORMS
  const SHOP = 256; // MANAGE_PRODUCTS
  const PAYOUT = 512; // MANAGE_PAYOUT_ACCOUNT

  async function writeFor(type: 'list' | 'association') {
    const { service } = makeService({ camp: { type } });
    const update = jest.fn(() => Promise.resolve({ affected: 1 }));
    const memberRepo = {
      findOne: jest.fn(() => Promise.resolve({ id: 'm1', permissions: MEMBERS })),
      update,
      // The write runs under the association's lock; its repository is this one.
      manager: {
        transaction: (run: (m: unknown) => Promise<unknown>) =>
          run({ query: () => Promise.resolve([]), getRepository: () => memberRepo }),
      },
    };
    Object.assign(service as object, { memberRepo });
    await service.updateMemberRole('camp', 'user-1', undefined, MEMBERS | FORMS | SHOP | PAYOUT, {
      granter: { userId: 'platform-admin', isGlobalAdmin: true },
    });
    return (update.mock.calls[0] as unknown[])[1] as { permissions: number };
  }

  it('drops only the payout right for a list, keeping its shop', async () => {
    expect((await writeFor('list')).permissions).toBe(MEMBERS | FORMS | SHOP);
  });

  it('keeps every right for an association', async () => {
    expect((await writeFor('association')).permissions).toBe(MEMBERS | FORMS | SHOP | PAYOUT);
  });
});

describe('AssociationsService payment delegation', () => {
  describe('requestPaymentDelegation', () => {
    it('rejects delegating to itself', async () => {
      const { service } = makeService({ club: {} });
      await expect(service.requestPaymentDelegation('club', 'club')).rejects.toThrow(
        BadRequestException
      );
    });

    it('sets a pending link to the chosen parent', async () => {
      const { service, db } = makeService({ club: {}, parent: { ...ready } });
      const state = await service.requestPaymentDelegation('club', 'parent');
      expect(db.get('club').paymentDelegationStatus).toBe('pending');
      expect(db.get('club').paymentParentAssociationId).toBe('parent');
      expect(state).toMatchObject({
        status: 'pending',
        parentAssociationId: 'parent',
        parentReady: true,
      });
    });

    it.each([
      ['no Lydia account', { lydiaOnboardingComplete: false, lydiaAccountId: null }],
      [
        'an account whose onboarding is not complete',
        { lydiaOnboardingComplete: false, lydiaAccountId: 'vendor_x' },
      ],
      ['a complete flag with no account', { lydiaOnboardingComplete: true, lydiaAccountId: null }],
    ])('reports the parent as not ready with %s', async (_name, parent) => {
      const { service } = makeService({ club: {}, parent });
      const state = await service.requestPaymentDelegation('club', 'parent');
      expect(state.parentReady).toBe(false);
    });

    it('rejects a parent that itself delegates (no chains)', async () => {
      const { service } = makeService({
        club: {},
        parent: { paymentParentAssociationId: 'grandparent', paymentDelegationStatus: 'approved' },
      });
      await expect(service.requestPaymentDelegation('club', 'parent')).rejects.toThrow(
        /itself delegates/
      );
    });

    it('rejects when the requester is already a parent to others', async () => {
      const { service } = makeService({
        club: {},
        parent: { ...ready },
        grandchild: { paymentParentAssociationId: 'club', paymentDelegationStatus: 'approved' },
      });
      await expect(service.requestPaymentDelegation('club', 'parent')).rejects.toThrow(
        /already receives delegated payments/
      );
    });
  });

  // Approve, reject, revoke and cancel run in a transaction with row locks, the product pause and
  // the acceptance record: proven against PostgreSQL in `payment-delegation.integration.spec.ts`.

  // Owner review of #2967 (2026-11-03): a receiver reads a child's accounting while approved, and
  // after the delegation ended the payments ITS Business took - never anything else.
  describe('childAccountingScope', () => {
    const withTaken = (service: AssociationsService, taken: string[]) => {
      const repo = (service as unknown as { assoRepo: { manager: Record<string, unknown> } })
        .assoRepo;
      const query = jest.fn(async () => taken.map((id) => ({ id })));
      repo.manager.query = query;
      return query;
    };

    it('reads everything while the delegation to this parent is approved', async () => {
      const { service } = makeService({
        parent: { lydiaAccountId: 'vendor-p' },
        club: { paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' },
      });
      const query = withTaken(service, []);
      await expect(service.childAccountingScope('parent', 'club')).resolves.toEqual({
        onlyRecordIds: null,
      });
      expect(query).not.toHaveBeenCalled();
    });

    it('after a revoke, reads only the payments its Business took', async () => {
      const { service } = makeService({
        parent: { lydiaAccountId: 'vendor-p' },
        club: { paymentParentAssociationId: 'other', paymentDelegationStatus: 'approved' },
      });
      const query = withTaken(service, ['p1', 'p2']);
      await expect(service.childAccountingScope('parent', 'club')).resolves.toEqual({
        onlyRecordIds: ['p1', 'p2'],
      });
      expect(query.mock.calls[0]).toEqual([expect.any(String), ['club', 'vendor-p']]);
    });

    it('refuses a parent that is not approved and took nothing (a pending request included)', async () => {
      const { service } = makeService({
        parent: { lydiaAccountId: 'vendor-p' },
        club: { paymentParentAssociationId: 'parent', paymentDelegationStatus: 'pending' },
      });
      withTaken(service, []);
      await expect(service.childAccountingScope('parent', 'club')).rejects.toThrow(
        ForbiddenException
      );
    });
  });

  describe('listDelegatedChildren', () => {
    it('returns pending and approved children, excluding unrelated ones', async () => {
      const { service } = makeService({
        parent: { ...ready },
        a: { name: 'A', paymentParentAssociationId: 'parent', paymentDelegationStatus: 'pending' },
        b: { name: 'B', paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' },
        c: {
          name: 'C',
          paymentParentAssociationId: 'someone-else',
          paymentDelegationStatus: 'approved',
        },
      });
      const children = await service.listDelegatedChildren('parent');
      expect(children.map((c) => c.associationId).sort()).toEqual(['a', 'b']);
    });
  });
});
