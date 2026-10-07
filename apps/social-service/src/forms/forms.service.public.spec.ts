import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FormsService } from './forms.service';

/**
 * A PUBLIC FORM IS ANSWERED BY SOMEBODY WITH NO ACCOUNT, AND EVERY RULE HERE FOLLOWS FROM THAT.
 *
 * Nobody to charge, to grant to, to match a criterion against or to recognise twice - so each of
 * those is refused at save time, and a guest's row is asserted to carry no account at all.
 */
describe('FormsService - public forms', () => {
  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: 'u-owner',
    associationId: 'a1',
    title: 'Inscription au gala',
    description: 'Ouvert a tous',
    imageUrl: null,
    isPublic: true,
    anonymous: false,
    requiresPayment: false,
    currency: 'eur',
    basePrice: 0,
    allowMultipleSubmissions: true,
    maxSubmissions: null,
    opensAt: null,
    closedAt: null,
    priceMatrix: null,
    submitCondition: null,
    items: [{ id: 'q1', label: 'Nom prenom', required: true, type: 'short_text' }],
    ...over,
  });

  function makeService(opts: { form?: Record<string, unknown> | null } = {}) {
    const saved: Record<string, unknown>[] = [];
    const manager: any = {
      query: jest.fn(() => Promise.resolve([{ formId: 'f1' }])),
      create: jest.fn((_entity: unknown, row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve({ id: 's1', ...row });
      }),
      count: jest.fn(() => Promise.resolve(0)),
    };
    const formRepo: any = {
      findOne: jest.fn(() =>
        Promise.resolve(opts.form === undefined ? baseForm() : (opts.form ?? null))
      ),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
    };
    const submissionRepo: any = {
      count: jest.fn(() => Promise.resolve(0)),
      manager: { transaction: jest.fn((_l: string, fn: any) => fn(manager)) },
    };
    const pricingFacts: any = { build: jest.fn(() => Promise.resolve({ answers: {} })) };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      { isMember: jest.fn(() => Promise.resolve(true)) } as any,
      {} as any,
      {} as any,
      pricingFacts,
      { count: jest.fn() } as any
    );
    return { service, manager, saved, formRepo, submissionRepo, pricingFacts };
  }

  describe('get', () => {
    it('answers 404 for a form that does not exist, never an empty 200', async () => {
      const { service } = makeService({ form: null });
      await expect(service.get('gone')).rejects.toThrow(NotFoundException);
    });

    it('returns the form with its submission count', async () => {
      const { service } = makeService();
      const form = await service.get('f1');
      expect(form.id).toBe('f1');
      expect(form.submissionCount).toBe(0);
    });
  });

  describe('getPublic', () => {
    it('serves the questions and nothing about who made the form', async () => {
      const { service } = makeService();
      const form = await service.getPublic('f1');
      expect(form.items).toHaveLength(1);
      expect(form).not.toHaveProperty('ownerId');
      expect(form).not.toHaveProperty('associationId');
      expect(form.formFull).toBe(false);
    });

    it('reports a form that is not public as absent', async () => {
      const { service } = makeService({ form: baseForm({ isPublic: false }) });
      await expect(service.getPublic('f1')).rejects.toThrow(NotFoundException);
    });

    it('says when the form is full', async () => {
      const { service, submissionRepo } = makeService({ form: baseForm({ maxSubmissions: 3 }) });
      submissionRepo.count.mockResolvedValueOnce(3);
      expect((await service.getPublic('f1')).formFull).toBe(true);
    });
  });

  describe('guest submit', () => {
    it('stores the answer with no account, and keeps its real time', async () => {
      const { service, saved, manager } = makeService();
      await service.submit('f1', { answers: { q1: 'Ada Lovelace' } }, 'guest');
      expect(saved).toHaveLength(1);
      expect(saved[0].userId).toBeNull();
      expect(saved[0].paymentStatus).toBe('free');
      expect(saved[0]).not.toHaveProperty('createdAt');
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('cuts the time to the day when the public form is also anonymous', async () => {
      const { service, saved } = makeService({ form: baseForm({ anonymous: true }) });
      await service.submit('f1', { answers: { q1: 'Ada' } }, 'guest');
      const at = saved[0].createdAt as Date;
      expect([at.getUTCHours(), at.getUTCMinutes()]).toEqual([0, 0]);
    });

    it('takes a second answer from the same link', async () => {
      const { service, saved } = makeService();
      await service.submit('f1', { answers: { q1: 'Ada' } }, 'guest');
      await service.submit('f1', { answers: { q1: 'Ada' } }, 'guest');
      expect(saved).toHaveLength(2);
    });

    it('refuses a guest on a form that is not public, as if it did not exist', async () => {
      const { service, saved } = makeService({ form: baseForm({ isPublic: false }) });
      await expect(service.submit('f1', { answers: { q1: 'Ada' } }, 'guest')).rejects.toThrow(
        NotFoundException
      );
      expect(saved).toHaveLength(0);
    });

    it('enforces the required questions', async () => {
      const { service, saved } = makeService();
      await expect(service.submit('f1', { answers: {} }, 'guest')).rejects.toThrow(
        BadRequestException
      );
      expect(saved).toHaveLength(0);
    });

    it('refuses a form that is not open yet', async () => {
      const { service } = makeService({
        form: baseForm({ opensAt: new Date(Date.now() + 60_000) }),
      });
      await expect(service.submit('f1', { answers: { q1: 'Ada' } }, 'guest')).rejects.toThrow(
        BadRequestException
      );
    });

    it('refuses to charge for an option, since a guest has no account to charge', async () => {
      const { service, saved } = makeService({
        form: baseForm({
          items: [
            {
              id: 'q1',
              label: 'Menu',
              required: false,
              type: 'single_choice',
              options: [{ id: 'o1', label: 'Gros', priceModifier: 500 }],
            },
          ],
        }),
      });
      await expect(service.submit('f1', { answers: { q1: ['o1'] } }, 'guest')).rejects.toThrow(
        BadRequestException
      );
      expect(saved).toHaveLength(0);
    });

    it('asks for no profile to decide what a guest sees', async () => {
      const { service, pricingFacts } = makeService();
      await service.submit('f1', { answers: { q1: 'Ada' } }, 'guest');
      expect(pricingFacts.build).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined, needProfile: false })
      );
    });
  });

  describe('configuration', () => {
    const input = (over: Record<string, unknown> = {}) =>
      ({
        title: 'T',
        basePrice: 0,
        currency: 'eur',
        items: [],
        ownerId: 'u1',
        isPublic: true,
        allowMultipleSubmissions: true,
        ...over,
      }) as any;

    it.each([
      ['requiresPayment', { requiresPayment: true }],
      ['a base price', { basePrice: 500 }],
      ['a price grid', { priceMatrix: { dimensions: [], cells: {} } }],
      ['cash', { allowCashPayment: true }],
      ['a cotisation grant', { grantsCotisation: true }],
      ['an audience condition', { submitCondition: { promo: [2026] } }],
      [
        'a question shown by promo',
        { items: [{ id: 'q1', label: 'L', type: 'short_text', showIf: { promo: [2026] } }] },
      ],
      ['a single answer per person', { allowMultipleSubmissions: false }],
    ])('refuses a public form with %s', async (_name, over) => {
      const { service, formRepo } = makeService();
      await expect(service.create(input(over))).rejects.toThrow(BadRequestException);
      expect(formRepo.save).not.toHaveBeenCalled();
    });

    it('accepts a free public form whose questions depend only on answers', async () => {
      const { service, formRepo } = makeService();
      await service.create(
        input({
          items: [
            { id: 'q1', label: 'Vient ?', type: 'single_choice', options: [{ id: 'o1' }] },
            {
              id: 'q2',
              label: 'Avec qui ?',
              type: 'short_text',
              showIf: { answer: { questionId: 'q1', optionIds: ['o1'] } },
            },
          ],
        })
      );
      expect(formRepo.save).toHaveBeenCalled();
    });

    it('checks the stored flag when an edit leaves it out', async () => {
      const { service } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(baseForm() as any);
      await expect(
        service.update('f1', input({ isPublic: undefined, basePrice: 500 }), 'u1', false)
      ).rejects.toThrow(BadRequestException);
    });
  });
});
