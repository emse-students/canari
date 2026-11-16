import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FormsService } from './forms.service';
import { FORM_PUBLISHED } from './form-status';
import { FORM_FINGERPRINT_SQL } from './form-draft-revision';
import { FORM_CLOSE_BEFORE_OPEN, assertWindowOrdered } from './form-window';

jest.mock('./form-draft-revision', () => ({
  ...jest.requireActual('./form-draft-revision'),
  readFormDraft: jest.fn(async () => ({
    revision: 0,
    document: null,
    savedAt: null,
    saveId: null,
  })),
}));

/**
 * "CLORE LE FORMULAIRE" (owner, 2026-11-16): `setClosed` writes `closedAt` and nothing else, for
 * exactly the people who may edit the form, and an edit never reopens what a manager closed.
 */
describe('FormsService - closing and reopening a form', () => {
  const OWNER = 'u-owner';
  const STRANGER = 'u-stranger';
  const ADMIN = 'u-asso-admin';

  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: OWNER,
    associationId: null,
    title: 'Gala',
    description: '',
    isPublic: false,
    anonymous: false,
    requiresPayment: false,
    currency: 'eur',
    basePrice: 0,
    maxSubmissions: null,
    opensAt: null,
    closedAt: null,
    priceMatrix: null,
    submitCondition: null,
    deletedAt: null,
    status: FORM_PUBLISHED,
    items: [{ id: 'q1', label: 'Nom', required: true, type: 'short_text' }],
    ...over,
  });

  function makeService(over: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = baseForm(over);
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve({ ...row })),
      update: jest.fn((_where: unknown, values: Record<string, unknown>) => {
        Object.assign(row, values);
        return Promise.resolve({ affected: 1 });
      }),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve(x)),
      manager: { transaction: jest.fn(), query: jest.fn() },
    };
    // The association's form managers (MANAGE_FORMS) are ADMIN alone; the owner of an association's
    // form does not manage it by being its owner (owner, 2026-11-14).
    const associations: any = {
      mayAct: jest.fn((user: string) => Promise.resolve(user === ADMIN)),
      collectsNow: jest.fn(() => Promise.resolve(true)),
      collectionSubjectOf: jest.fn(() => Promise.resolve(null)),
      namesByIds: jest.fn(() => Promise.resolve(new Map())),
      canTakePaymentsNow: jest.fn(() => Promise.resolve(true)),
    };
    const service = new FormsService(
      formRepo,
      { count: jest.fn(() => Promise.resolve(0)), manager: {} } as any,
      {} as any,
      { get: jest.fn() } as any,
      associations,
      { listCotisationTiers: jest.fn(() => Promise.resolve([])) } as any,
      {} as any,
      {} as any,
      { count: jest.fn() } as any,
      {} as any,
      { enabled: () => false } as any,
      {} as any
    );
    return { service, row, formRepo };
  }

  describe('who may', () => {
    it('lets the owner of a personal form close and reopen it', async () => {
      const { service, row } = makeService();
      const before = Date.now();
      const closed = await service.setClosed('f1', true, OWNER, false);
      expect((row.closedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect(closed.closedAt).toBe(row.closedAt);
      await service.setClosed('f1', false, OWNER, false);
      expect(row.closedAt).toBeNull();
    });

    it('refuses a stranger, on both routes, and writes nothing', async () => {
      const { service, formRepo } = makeService();
      await expect(service.setClosed('f1', true, STRANGER, false)).rejects.toThrow(
        ForbiddenException
      );
      await expect(service.setClosed('f1', false, STRANGER, false)).rejects.toThrow(
        ForbiddenException
      );
      expect(formRepo.update).not.toHaveBeenCalled();
    });

    it('lets a member holding MANAGE_FORMS close an association form, and a global admin', async () => {
      const { service, row } = makeService({ associationId: 'a1' });
      await service.setClosed('f1', true, ADMIN, false);
      expect(row.closedAt).toBeInstanceOf(Date);
      await service.setClosed('f1', false, STRANGER, true);
      expect(row.closedAt).toBeNull();
    });

    it('refuses the creator of an association form who does not hold MANAGE_FORMS', async () => {
      const { service, formRepo } = makeService({ associationId: 'a1' });
      await expect(service.setClosed('f1', true, OWNER, false)).rejects.toThrow(ForbiddenException);
      expect(formRepo.update).not.toHaveBeenCalled();
    });

    it('answers 404 for an archived form', async () => {
      const { service } = makeService({ deletedAt: new Date() });
      await expect(service.setClosed('f1', true, OWNER, false)).rejects.toThrow(NotFoundException);
    });
  });

  describe('what it writes', () => {
    it('keeps the first end date when closing a form already closed', async () => {
      const first = new Date('2026-01-01T00:00:00Z');
      const { service, row } = makeService({ closedAt: first });
      await service.setClosed('f1', true, OWNER, false);
      expect((row.closedAt as Date).getTime()).toBe(first.getTime());
    });

    it('closes NOW a form whose end is still to come, and reopens one whose end is to come', async () => {
      const future = new Date(Date.now() + 86_400_000);
      const { service, row } = makeService({ closedAt: future });
      await service.setClosed('f1', true, OWNER, false);
      expect((row.closedAt as Date).getTime()).toBeLessThan(future.getTime());
      row.closedAt = future;
      await service.setClosed('f1', false, OWNER, false);
      expect(row.closedAt).toBeNull();
    });

    it('is not part of the unpublished revision: the fingerprint excludes closedAt', () => {
      expect(FORM_FINGERPRINT_SQL).toContain("'closedAt'");
    });
  });

  describe('an edit does not reopen a closed form', () => {
    const edit = (over: Record<string, unknown> = {}) =>
      ({
        title: 'Gala',
        basePrice: 0,
        currency: 'eur',
        items: [{ id: 'q1', label: 'Nom', required: true, type: 'short_text' }],
        ...over,
      }) as any;

    it('keeps the stored end when the edit carries none', async () => {
      const closedAt = new Date('2026-05-01T00:00:00Z');
      const { service, formRepo } = makeService({ closedAt });
      await service.update('f1', edit(), OWNER, false);
      expect(formRepo.save.mock.calls[0][0].closedAt).toBe(closedAt);
    });

    it('sets and clears the end only when the edit says so', async () => {
      const { service, formRepo } = makeService({ closedAt: new Date('2026-05-01T00:00:00Z') });
      await service.update('f1', edit({ closedAt: '2027-01-01T00:00:00.000Z' }), OWNER, false);
      expect(formRepo.save.mock.calls[0][0].closedAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
      await service.update('f1', edit({ closedAt: null }), OWNER, false);
      expect(formRepo.save.mock.calls[1][0].closedAt).toBeNull();
    });

    it('refuses, typed, an end that is not after the opening', async () => {
      const { service, formRepo } = makeService();
      await expect(
        service.update(
          'f1',
          edit({ opensAt: '2027-02-01T00:00:00.000Z', closedAt: '2027-01-01T00:00:00.000Z' }),
          OWNER,
          false
        )
      ).rejects.toMatchObject({ response: { code: FORM_CLOSE_BEFORE_OPEN } });
      expect(formRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('assertWindowOrdered', () => {
    const d = (s: string) => new Date(s);
    it('accepts an end after the opening, and either bound absent', () => {
      expect(() => assertWindowOrdered(d('2027-01-01'), d('2027-01-02'))).not.toThrow();
      expect(() => assertWindowOrdered(null, d('2027-01-02'))).not.toThrow();
      expect(() => assertWindowOrdered(d('2027-01-01'), null)).not.toThrow();
    });
    it('refuses an end equal to or before the opening', () => {
      expect(() => assertWindowOrdered(d('2027-01-01'), d('2027-01-01'))).toThrow('closing date');
      expect(() => assertWindowOrdered(d('2027-01-02'), d('2027-01-01'))).toThrow('closing date');
    });
  });
});
