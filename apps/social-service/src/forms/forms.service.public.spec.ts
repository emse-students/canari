import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FormsService } from './forms.service';
import { OTHERS_BUCKET_ID } from '../pricing/audience';

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
      { count: jest.fn() } as any,
      {} as any,
      // FormOrganiserAlertService: switched off, as it ships.
      { enabled: () => false } as any
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

    // An allowlist: a guest is served exactly these keys. Control: answer `{ ...form, formFull }`
    // and this fails on `ownerId`, `associationId` and every other stored column.
    it('serves exactly the allowlisted fields, the price included', async () => {
      const { service } = makeService({
        form: baseForm({ basePrice: 1200, allowCashPayment: true, grantsCotisation: false }),
      });
      const form = await service.getPublic('f1');
      expect(Object.keys(form).sort()).toEqual(
        [
          'allowCashPayment',
          'anonymous',
          'basePrice',
          'closedAt',
          'currency',
          'description',
          'formFull',
          'id',
          'imageUrl',
          'items',
          'opensAt',
          'pricing',
          'title',
        ].sort()
      );
      expect(form).toMatchObject({ basePrice: 1200, allowCashPayment: true, pricing: null });
    });

    it("serves a grid on answers as the guest's whole slice", async () => {
      const { service } = makeService({
        form: baseForm({
          priceMatrix: {
            dimensions: [
              {
                id: 'menu',
                kind: 'answer',
                questionId: 'q1',
                buckets: [{ id: 'veg', label: 'Vegetarien', values: ['opt_veg'] }],
              },
            ],
            cells: { veg: 1000, _others: 1500 },
          },
        }),
      });
      const { pricing } = await service.getPublic('f1');
      expect(pricing).toMatchObject({ cells: { veg: 1000, _others: 1500 }, appliedLabels: [] });
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
      // The one statement is the form's seat lock: a guest is never written to the registry.
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query.mock.calls[0][0]).toContain('FOR UPDATE');
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

    /** A grid on one criterion of `kind`, complete, as the editor saves it. */
    const gridOn = (kind: string, extra: Record<string, unknown> = {}) => ({
      dimensions: [
        {
          id: 'd1',
          kind,
          ...extra,
          buckets: [{ id: 'b1', label: 'Groupe', values: ['opt_a'] }],
        },
      ],
      cells: { b1: 1000, [OTHERS_BUCKET_ID]: 1500 },
    });
    const menuQuestion = {
      id: 'q_menu',
      label: 'Menu',
      type: 'single_choice',
      options: [
        { id: 'opt_a', label: 'A', priceModifier: 0 },
        { id: 'opt_b', label: 'B', priceModifier: 300 },
      ],
    };

    // Each refusal below is a guard of `assertPublicConfigValid`. Controls (2026-10-22, WP-P1): with
    // the grant check removed the "cotisation grant" case fails; with the `kind !== 'answer'` check
    // removed the three profile-grid cases fail.
    // Each case names the sentence of ITS refusal: a later check (the cotisation validation, which
    // also refuses a grant with no association) must not be what makes the case pass.
    it.each([
      ['a cotisation grant', { grantsCotisation: true }, /cannot grant a cotisation/],
      ['a grid on promo', { priceMatrix: gridOn('promo') }, /price only on answers/],
      ['a grid on formation', { priceMatrix: gridOn('formation') }, /price only on answers/],
      ['a grid on cotisation', { priceMatrix: gridOn('cotisation') }, /price only on answers/],
      ['an audience condition', { submitCondition: { promo: [2026] } }, /depend on who answers/],
      [
        'a question shown by promo',
        { items: [{ id: 'q1', label: 'L', type: 'short_text', showIf: { promo: [2026] } }] },
        /depend on who answers/,
      ],
      ['a single answer per person', { allowMultipleSubmissions: false }, /several answers/],
    ])('refuses a public form with %s', async (_name, over, sentence) => {
      const { service, formRepo } = makeService();
      const refusal = service.create(input(over));
      await expect(refusal).rejects.toThrow(BadRequestException);
      await expect(refusal).rejects.toThrow(sentence);
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

    // PP1: a guest keeps everything that needs no account.
    it.each([
      ['a base price', { requiresPayment: true, basePrice: 500 }],
      ['cash', { requiresPayment: true, basePrice: 500, allowCashPayment: true }],
      ['an option supplement', { items: [menuQuestion] }],
      [
        'a grid on an answer',
        {
          requiresPayment: true,
          items: [menuQuestion],
          priceMatrix: gridOn('answer', { questionId: 'q_menu' }),
        },
      ],
    ])('accepts a public form with %s', async (_name, over) => {
      const { service, formRepo } = makeService();
      await service.create(input(over));
      expect(formRepo.save).toHaveBeenCalled();
    });

    it('checks the stored flag when an edit leaves it out', async () => {
      const { service } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(baseForm() as any);
      await expect(
        service.update('f1', input({ isPublic: undefined, grantsCotisation: true }), 'u1', false)
      ).rejects.toThrow(BadRequestException);
    });

    // An edit sending only `isPublic: true` must not publish what is STORED and refused.
    // Control: pass `input.grantsCotisation` / `input.priceMatrix` alone to the check (as before
    // WP-P1) and both cases save.
    it.each([
      ['a stored cotisation grant', { grantsCotisation: true }],
      ['a stored grid on promo', { priceMatrix: gridOn('promo') }],
    ])('refuses to publish a form holding %s that the edit leaves out', async (_name, stored) => {
      const { service, formRepo } = makeService();
      jest
        .spyOn(service, 'assertFormManager')
        .mockResolvedValue(baseForm({ isPublic: false, ...stored }) as any);
      await expect(
        service.update('f1', { isPublic: true, allowMultipleSubmissions: true } as any, 'u1', false)
      ).rejects.toThrow(BadRequestException);
      expect(formRepo.save).not.toHaveBeenCalled();
    });
  });
});
