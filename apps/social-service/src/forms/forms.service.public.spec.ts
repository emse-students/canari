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

    // A PRICED ANSWER NAMES THE QUESTION'S OWN OPTIONS (`answer-options.ts`). Controls (2026-10-22):
    // the `assertDeclaredOptionAnswers` call removed from `submit` -> the three refusals below fail
    // (the grid case reaches the "everyone else" price, the supplement case a free row); the
    // stored answers back to `input.answers` -> the hidden-question case fails.
    describe('priced answers', () => {
      const grid = {
        dimensions: [
          {
            id: 'd1',
            kind: 'answer',
            questionId: 'q_menu',
            buckets: [{ id: 'b1', label: 'Menu', values: ['opt_a', 'opt_b'] }],
          },
        ],
        cells: { b1: 1200, [OTHERS_BUCKET_ID]: 0 },
      };
      const menu = {
        id: 'q_menu',
        label: 'Menu',
        type: 'single_choice',
        required: true,
        options: [
          { id: 'opt_a', label: 'A', priceModifier: 0 },
          { id: 'opt_b', label: 'B', priceModifier: 0 },
        ],
      };
      const extra = {
        id: 'q_extra',
        label: 'Supplement',
        type: 'multiple_choice',
        required: false,
        options: [{ id: 'opt_wine', label: 'Vin', priceModifier: 500 }],
      };

      it.each([
        ['an option id the grid question never declared', { q_menu: 'opt_premium' }],
        ['a list where one choice is asked', { q_menu: ['opt_a', 'opt_b'] }],
        ['an option id the supplement question never declared', { q_extra: ['opt_free_wine'] }],
        ['the same supplement twice', { q_extra: ['opt_wine', 'opt_wine'] }],
      ])('refuses %s', async (_name, answers) => {
        const { service, saved } = makeService({
          form: baseForm({ requiresPayment: true, priceMatrix: grid, items: [menu, extra] }),
        });
        await expect(
          service.submit('f1', { answers: { q_menu: 'opt_a', ...answers } } as any, 'guest')
        ).rejects.toThrow(/is not one of its options/);
        expect(saved).toEqual([]);
      });

      it('holds a member to the same rule', async () => {
        const { service, saved } = makeService({
          form: baseForm({ isPublic: false, items: [extra] }),
        });
        await expect(
          service.submit('f1', { answers: { q_extra: ['opt_free_wine'] }, userId: 'u1' } as any)
        ).rejects.toThrow(/is not one of its options/);
        expect(saved).toEqual([]);
      });

      // The TYPE decides whether options charge: a question turned into a matrix keeps its old
      // options' modifiers, and its answer is an object that never charged. Control (2026-10-22):
      // `decidesPrice` reading the modifiers alone -> this member's answer is refused.
      it("accepts a member's matrix answer whose question kept an old option supplement", async () => {
        const matrix = {
          id: 'q_mx',
          label: 'Disponibilites',
          type: 'matrix_single',
          required: false,
          rows: ['r1'],
          options: [{ id: 'c1', label: 'Oui', priceModifier: 500 }],
        };
        const { service, saved } = makeService({
          form: baseForm({ isPublic: false, items: [matrix] }),
        });
        await service.submit('f1', { answers: { q_mx: { r1: 'c1' } }, userId: 'u1' } as any);
        expect(saved).toHaveLength(1);
        expect(saved[0].answers).toEqual({ q_mx: { r1: 'c1' } });
      });

      it('does not store the answer to a priced question the guest did not see', async () => {
        const premium = {
          id: 'q_premium',
          label: 'Formule',
          type: 'single_choice',
          required: false,
          showIf: { answer: { questionId: 'q_come', optionIds: ['yes'] } },
          options: [{ id: 'opt_vip', label: 'VIP', priceModifier: 5000 }],
        };
        const come = {
          id: 'q_come',
          label: 'Diner ?',
          type: 'single_choice',
          required: true,
          options: [
            { id: 'yes', label: 'Oui', priceModifier: 0 },
            { id: 'no', label: 'Non', priceModifier: 0 },
          ],
        };
        const { service, saved } = makeService({ form: baseForm({ items: [come, premium] }) });
        await service.submit('f1', { answers: { q_come: 'no', q_premium: 'opt_vip' } }, 'guest');
        expect(saved[0]).toMatchObject({ paymentStatus: 'free', totalPaid: 0 });
        expect(saved[0].answers).toEqual({ q_come: 'no' });
      });
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

    // A charging grid must not give a guest a FREE seat by default. Control (2026-10-22): the
    // `freeFallbackCells` refusal removed from `assertPublicConfigValid` -> the three refusals save.
    describe('the "everyone else" price of a charging grid', () => {
      const grid = (others: number | null) => ({
        dimensions: [
          {
            id: 'd1',
            kind: 'answer',
            questionId: 'q_menu',
            buckets: [{ id: 'b1', label: 'Menu', values: ['opt_a', 'opt_b'] }],
          },
        ],
        cells: { b1: 1200, [OTHERS_BUCKET_ID]: others },
      });
      const menu = (over: Record<string, unknown> = {}) => ({
        id: 'q_menu',
        label: 'Menu',
        type: 'single_choice',
        required: true,
        options: [
          { id: 'opt_a', label: 'A', priceModifier: 0 },
          { id: 'opt_b', label: 'B', priceModifier: 0 },
        ],
        ...over,
      });
      const gate = {
        id: 'q_come',
        label: 'Diner ?',
        type: 'single_choice',
        options: [{ id: 'y' }],
      };

      it.each([
        ['the priced question may be skipped', [menu({ required: false })]],
        [
          'the priced question may be hidden by an answer',
          [gate, menu({ showIf: { answer: { questionId: 'q_come', optionIds: ['y'] } } })],
        ],
        [
          'an option belongs to no group',
          [menu({ options: [{ id: 'opt_a' }, { id: 'opt_b' }, { id: 'opt_c' }] })],
        ],
      ])('refuses it at 0 when %s', async (_name, items) => {
        const { service, formRepo } = makeService();
        await expect(
          service.create(input({ requiresPayment: true, items, priceMatrix: grid(0) }))
        ).rejects.toThrow(/"everyone else" price at 0/);
        expect(formRepo.save).not.toHaveBeenCalled();
      });

      it.each([
        ['priced', [menu({ required: false })], grid(800)],
        ['unavailable', [menu({ required: false })], grid(null)],
        ['unreachable: required, shown to all, every option grouped', [menu()], grid(0)],
      ])('accepts it %s', async (_name, items, priceMatrix) => {
        const { service, formRepo } = makeService();
        await service.create(input({ requiresPayment: true, items, priceMatrix }));
        expect(formRepo.save).toHaveBeenCalled();
      });

      // Two questions with one id: one reader judged the first, another the last, so a required,
      // shown-to-all copy hid a skippable one. Ids are unique at create, and on an edit whose
      // questions' ids differ from the stored ones; a duplicate ALREADY STORED never blocks an edit
      // that leaves those ids as they are. Controls (2026-10-22): the refusal removed -> the create
      // and the two edit refusals save; the edit judged on the stored list as before (`input.items ??
      // form.items`, no stored comparison) -> the four edits that keep the ids are refused.
      const twinMenus = [
        gate,
        menu(),
        menu({ showIf: { answer: { questionId: 'q_come', optionIds: ['y'] } } }),
      ];

      it('refuses two questions with one id at create, naming both', async () => {
        const { service, formRepo } = makeService();
        await expect(
          service.create(input({ requiresPayment: true, items: twinMenus, priceMatrix: grid(0) }))
        ).rejects.toThrow('Questions 2 ("Menu") and 3 ("Menu") share the id q_menu');
        expect(formRepo.save).not.toHaveBeenCalled();
      });

      it('refuses an edit that makes two questions share an id', async () => {
        const { service, formRepo } = makeService();
        jest
          .spyOn(service, 'assertFormManager')
          .mockResolvedValue(baseForm({ items: [gate, menu()], priceMatrix: grid(0) }) as any);
        await expect(
          service.update('f1', { items: twinMenus } as any, 'u1', false)
        ).rejects.toThrow(/share the id q_menu/);
        expect(formRepo.save).not.toHaveBeenCalled();
      });

      describe('a form STORED with two questions sharing an id', () => {
        const stored = () => baseForm({ isPublic: false, items: twinMenus }) as any;
        /** A service whose form is `stored()`, past the cotisation lookup an edit of items makes. */
        const editing = () => {
          const made = makeService();
          jest.spyOn(made.service, 'assertFormManager').mockResolvedValue(stored());
          jest
            .spyOn(made.service as any, 'assertCotisationConfigValid')
            .mockResolvedValue(undefined);
          return made;
        };

        it.each([
          ['its title', { title: 'Gala 2027' }],
          ['its cash deadline', { cashPaymentExpiryDays: 3 }],
          ['its closing', { closedAt: '2026-11-01T00:00:00.000Z' }],
          // What the edit page sends for a title change: the whole list, converted for the API.
          ['its title, the questions resent as they are', { title: 'Gala 2027', items: twinMenus }],
        ])('stays editable for %s', async (_name, edit) => {
          const { service, formRepo } = editing();
          await service.update('f1', edit as any, 'u1', false);
          expect(formRepo.save).toHaveBeenCalled();
        });

        it('is refused when its questions are edited and the duplicate kept', async () => {
          const { service, formRepo } = editing();
          const extra = { id: 'q_note', label: 'Remarque', type: 'short_text' };
          await expect(
            service.update('f1', { items: [...twinMenus, extra] } as any, 'u1', false)
          ).rejects.toThrow(/share the id q_menu/);
          expect(formRepo.save).not.toHaveBeenCalled();
        });

        it('saves the edit that fixes the duplicate', async () => {
          const { service, formRepo } = editing();
          const fixed = [twinMenus[0], twinMenus[1], { ...twinMenus[2], id: 'q_menu_2' }];
          await service.update('f1', { items: fixed } as any, 'u1', false);
          expect(formRepo.save).toHaveBeenCalled();
        });
      });

      it('refuses to publish a stored grid that the edit leaves out', async () => {
        const { service, formRepo } = makeService();
        jest.spyOn(service, 'assertFormManager').mockResolvedValue(
          baseForm({
            isPublic: false,
            items: [menu({ required: false })],
            priceMatrix: grid(0),
          }) as any
        );
        await expect(
          service.update(
            'f1',
            { isPublic: true, allowMultipleSubmissions: true } as any,
            'u1',
            false
          )
        ).rejects.toThrow(/"everyone else" price at 0/);
        expect(formRepo.save).not.toHaveBeenCalled();
      });
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
