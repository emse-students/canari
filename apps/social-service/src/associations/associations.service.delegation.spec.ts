import { BadRequestException } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import type { Association } from './entities/association.entity';

/**
 * Focused unit tests for the payment-delegation lifecycle. Only `assoRepo` and `redis` are
 * exercised, so the remaining constructor dependencies are passed as undefined.
 */
function makeService(seed: Record<string, Partial<Association>>) {
  const db = new Map<string, Association>();
  for (const [id, v] of Object.entries(seed))
    db.set(id, { id, name: id, slug: id, ...v } as Association);

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
  const redis = { deleteByPattern: jest.fn(() => Promise.resolve()) };

  const service = new AssociationsService(
    assoRepo as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    redis as never,
    undefined as never,
    undefined,
    undefined
  );
  return { service, db };
}

const ready = { stripeOnboardingComplete: true, stripeAccountId: 'acct_x' };

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

  describe('approvePaymentDelegation', () => {
    it('approves a pending request when the parent is stripe-ready', async () => {
      const { service, db } = makeService({
        club: { paymentParentAssociationId: 'parent', paymentDelegationStatus: 'pending' },
        parent: { ...ready },
      });
      const res = await service.approvePaymentDelegation('parent', 'club');
      expect(res).toEqual({ associationId: 'club', status: 'approved' });
      expect(db.get('club').paymentDelegationStatus).toBe('approved');
    });

    it('rejects approving when the parent has not finished onboarding', async () => {
      const { service } = makeService({
        club: { paymentParentAssociationId: 'parent', paymentDelegationStatus: 'pending' },
        parent: { stripeOnboardingComplete: false, stripeAccountId: null },
      });
      await expect(service.approvePaymentDelegation('parent', 'club')).rejects.toThrow(
        /Stripe Connect onboarding/
      );
    });

    it('rejects approving when there is no pending request for this parent', async () => {
      const { service } = makeService({
        club: { paymentParentAssociationId: 'other', paymentDelegationStatus: 'pending' },
        parent: { ...ready },
      });
      await expect(service.approvePaymentDelegation('parent', 'club')).rejects.toThrow(
        /No pending delegation request/
      );
    });
  });

  describe('reject / cancel', () => {
    it('rejects clears the child link', async () => {
      const { service, db } = makeService({
        club: { paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' },
      });
      await service.rejectPaymentDelegation('parent', 'club');
      expect(db.get('club').paymentParentAssociationId).toBeNull();
      expect(db.get('club').paymentDelegationStatus).toBeNull();
    });

    it('reject refuses a child that does not delegate to this parent', async () => {
      const { service } = makeService({
        club: { paymentParentAssociationId: 'other', paymentDelegationStatus: 'approved' },
      });
      await expect(service.rejectPaymentDelegation('parent', 'club')).rejects.toThrow(
        /does not delegate payments to you/
      );
    });

    it('cancel clears the association own link', async () => {
      const { service, db } = makeService({
        club: { paymentParentAssociationId: 'parent', paymentDelegationStatus: 'pending' },
      });
      await service.cancelPaymentDelegation('club');
      expect(db.get('club').paymentParentAssociationId).toBeNull();
      expect(db.get('club').paymentDelegationStatus).toBeNull();
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
