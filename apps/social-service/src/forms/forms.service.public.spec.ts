import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FormsService } from './forms.service';
import { OTHERS_BUCKET_ID } from '../pricing/audience';
import { plainToInstance } from 'class-transformer';
import { FORM_GRID_MULTIPLE_CHOICE_SPLIT } from './answer-bounds';
import { CreateFormDto } from './dto/form.dto';

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

  function makeService(
    opts: { form?: Record<string, unknown> | null; collectsNow?: boolean } = {}
  ) {
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
    const namesByIds = jest.fn((_ids: string[]) => Promise.resolve(new Map<string, string>()));
    const pricingFacts: any = { build: jest.fn(() => Promise.resolve({ answers: {} })) };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      {
        isMember: jest.fn(() => Promise.resolve(true)),
        // The editor manages the association's forms (MANAGE_FORMS, owner 2026-11-14).
        mayAct: jest.fn(() => Promise.resolve(true)),
        collectsNow: jest.fn(() => Promise.resolve(opts.collectsNow ?? true)),
        // An edit that starts charging asks what kind the association is: one that sells.
        collectionSubjectOf: jest.fn(() => Promise.resolve(null)),
        assertPaymentsReady: jest.fn(() => Promise.resolve()),
        namesByIds,
        canTakePaymentsNow: jest.fn(() => Promise.resolve(true)),
      } as any,
      // UserTagService: the association sells no cotisation, so a grid on promo needs no tier.
      { listCotisationTiers: jest.fn(() => Promise.resolve([])) } as any,
      {} as any,
      pricingFacts,
      { count: jest.fn() } as any,
      {} as any,
      // FormOrganiserAlertService: switched off, as it ships.
      { enabled: () => false } as any,
      {} as any
    );
    return { service, manager, saved, formRepo, submissionRepo, pricingFacts, namesByIds };
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
      expect(form.associationName).toBeNull();
    });

    it('carries the association name on the single read, as the list does', async () => {
      const { service, namesByIds } = makeService({ form: baseForm({ associationId: 'a1' }) });
      namesByIds.mockResolvedValue(new Map([['a1', 'BDE']]));
      expect((await service.get('f1')).associationName).toBe('BDE');
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

    // A guest reads a question's image with no session: the item carries the PUBLIC route, which
    // needs no token (unlike an avatar, signed since phase 1), and its alt text.
    it("serves a question's image as its public media route, readable with no session", async () => {
      const imageUrl = '/api/media/public/11111111-1111-4111-8111-111111111111';
      const { service } = makeService({
        form: baseForm({
          items: [
            {
              id: 'q1',
              label: 'Plat',
              required: true,
              type: 'short_text',
              imageUrl,
              imageAlt: 'Menu',
            },
          ],
        }),
      });
      const [item] = (await service.getPublic('f1')).items;
      expect(item).toMatchObject({ imageUrl, imageAlt: 'Menu' });
      expect(item.imageUrl).toMatch(/^\/api\/media\/public\/[0-9a-f-]{36}$/);
    });

    // An allowlist: a guest is served exactly these keys. Control: answer `{ ...form, formFull }`
    // and this fails on `ownerId`, `associationId` and every other stored column.
    // The link preview of a shared form (frontend serverSeo.ts) reads THIS answer, with no identity:
    // title, description and image are what its card needs, so they must stay in the allowlist.
    it('carries what a shared link card needs: title, description and image', async () => {
      const { service } = makeService({
        form: baseForm({ imageUrl: '/api/media/forms/f1/cover.jpg' }),
      });
      expect(await service.getPublic('f1')).toMatchObject({
        title: 'Inscription au gala',
        description: 'Ouvert a tous',
        imageUrl: '/api/media/forms/f1/cover.jpg',
      });
    });

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
          'guestFields',
          'id',
          'imageUrl',
          'items',
          'opensAt',
          'paymentsPaused',
          'pricing',
          'productGridPrices',
          'title',
        ].sort()
      );
      expect(form).toMatchObject({ basePrice: 1200, allowCashPayment: true, pricing: null });
    });

    // Owner, 2026-11-02: a paid form of an entity that cannot collect now (a list whose delegation
    // was revoked) is served PAUSED; a free form never is, whatever its association.
    it('serves a paid form paused while its association cannot collect, and a free one never', async () => {
      const paid = makeService({ form: baseForm({ basePrice: 1200 }), collectsNow: false });
      expect((await paid.service.getPublic('f1')).paymentsPaused).toBe(true);
      const live = makeService({ form: baseForm({ basePrice: 1200 }), collectsNow: true });
      expect((await live.service.getPublic('f1')).paymentsPaused).toBe(false);
      const free = makeService({ form: baseForm({ basePrice: 0 }), collectsNow: false });
      expect((await free.service.getPublic('f1')).paymentsPaused).toBe(false);
    });

    // Owner review of #2967: the pause reads the ONE charge predicate (`chargesMoney`), which counts
    // a choice option's supplement - a form priced by a supplement alone pauses too.
    it('pauses a form priced only by a choice supplement, and never by a text question', async () => {
      const choice = {
        id: 'q1',
        label: 'Menu',
        required: true,
        type: 'single_choice',
        options: [{ id: 'o1', label: 'Grand', priceModifier: 500 }],
      };
      const supplement = makeService({
        form: baseForm({ basePrice: 0, items: [choice] }),
        collectsNow: false,
      });
      expect((await supplement.service.getPublic('f1')).paymentsPaused).toBe(true);
      const text = makeService({
        form: baseForm({ basePrice: 0, items: [{ ...choice, type: 'short_text' }] }),
        collectsNow: false,
      });
      expect((await text.service.getPublic('f1')).paymentsPaused).toBe(false);
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
          buckets: [
            {
              id: 'b1',
              label: 'Groupe',
              values: kind === 'promo' ? [2026] : kind === 'formation' ? ['ICM'] : ['opt_a'],
            },
          ],
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

    // Each refusal below is a guard of `assertFormOptionsCoherent` (the shared pairs) or of
    // `assertPublicConfigValid`. Each case names the sentence of ITS refusal: a later check (the
    // cotisation validation, which also refuses a grant with no association) must not be what makes
    // the case pass. Control (2026-11-06): `FORM_PUBLIC_COTISATION_GRANT` deleted from the shared
    // table -> the grant case fails; `FORM_PUBLIC_AUDIENCE` deleted -> the two audience cases fail.
    it.each([
      ['a cotisation grant', { grantsCotisation: true }, /cannot grant a cotisation/],
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

    // The refusal carries the conflict's CODE, so the editor names the cause from it, never from
    // the sentence.
    it.each([
      ['a cotisation grant', { grantsCotisation: true }, 'FORM_PUBLIC_COTISATION_GRANT'],
      ['an audience condition', { submitCondition: { promo: [2026] } }, 'FORM_PUBLIC_AUDIENCE'],
      ['a file question', { items: [{ id: 'q1', label: 'CV', type: 'file' }] }, 'FORM_PUBLIC_FILE'],
    ])('refuses a public form with %s under its code', async (_name, over, code) => {
      const { service } = makeService();
      const refusal = await service.create(input(over)).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect((refusal as BadRequestException).getResponse()).toMatchObject({ code });
    });

    // A guest has no promo, formation or cotisation, so it lands in the "everyone else" tier of each
    // and pays that (owner, 2026-11-06). Control: the profile-kind refusal restored in
    // `assertPublicConfigValid` -> both cases fail.
    it.each([['promo'], ['formation']])(
      'accepts a public form with a grid on %s: a guest pays its "everyone else" tier',
      async (kind) => {
        const { service, formRepo } = makeService();
        await service.create(input({ requiresPayment: true, priceMatrix: gridOn(kind) }));
        expect(formRepo.save).toHaveBeenCalled();
      }
    );

    describe('the tier a guest pays on a grid by who the person is', () => {
      const promoGrid = (cells: Record<string, number | null>) => ({
        dimensions: [
          { id: 'd1', kind: 'promo', buckets: [{ id: 'b1', label: '1A', values: [2026] }] },
        ],
        cells,
      });

      // Control: `guestTierUnavailable` answering false -> the refusal saves.
      it('refuses it when the "everyone else" tier is unavailable: no guest could answer', async () => {
        const { service, formRepo } = makeService();
        const refusal = await service
          .create(
            input({
              requiresPayment: true,
              priceMatrix: promoGrid({ b1: 1000, [OTHERS_BUCKET_ID]: null }),
            })
          )
          .catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(BadRequestException);
        expect((refusal as BadRequestException).getResponse()).toMatchObject({
          code: 'FORM_PUBLIC_GUEST_TIER_UNAVAILABLE',
        });
        expect(formRepo.save).not.toHaveBeenCalled();
      });

      // Control: `isGuestCell` dropped from `freeFallbackCells` -> the member case is refused.
      it('refuses it free, and leaves a member tier free if the manager wants', async () => {
        const { service, formRepo } = makeService();
        await expect(
          service.create(
            input({
              requiresPayment: true,
              priceMatrix: promoGrid({ b1: 1000, [OTHERS_BUCKET_ID]: 0 }),
            })
          )
        ).rejects.toThrow(/"everyone else" price at 0/);
        await service.create(
          input({
            requiresPayment: true,
            priceMatrix: promoGrid({ b1: 0, [OTHERS_BUCKET_ID]: 1500 }),
          })
        );
        expect(formRepo.save).toHaveBeenCalledTimes(1);
      });
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
      [
        'cash, with its deadline',
        { requiresPayment: true, basePrice: 500, allowCashPayment: true, cashPaymentExpiryDays: 3 },
      ],
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
    // A multiple-choice answer can tick options of two groups, and the first group in the grid's
    // order would win: the price would depend on that order (backlog triage of 2026-11-11).
    describe('a grid on a multiple-choice question', () => {
      const extras = {
        id: 'q_extras',
        label: 'Extras',
        type: 'multiple_choice',
        options: [
          { id: 'opt_a', label: 'A', priceModifier: 0 },
          { id: 'opt_b', label: 'B', priceModifier: 0 },
        ],
      };
      const twoGroups = {
        dimensions: [
          {
            id: 'd1',
            kind: 'answer',
            questionId: 'q_extras',
            buckets: [
              { id: 'b1', label: 'A', values: ['opt_a'] },
              { id: 'b2', label: 'B', values: ['opt_b'] },
            ],
          },
        ],
        cells: { b1: 1000, b2: 1500, [OTHERS_BUCKET_ID]: 1200 },
      };
      const oneGroup = {
        dimensions: [
          {
            id: 'd1',
            kind: 'answer',
            questionId: 'q_extras',
            buckets: [{ id: 'b1', label: 'A ou B', values: ['opt_a', 'opt_b'] }],
          },
        ],
        cells: { b1: 1000, [OTHERS_BUCKET_ID]: 1200 },
      };

      it('refuses its options in two groups', async () => {
        const { service, formRepo } = makeService();
        await expect(
          service.create(input({ requiresPayment: true, items: [extras], priceMatrix: twoGroups }))
        ).rejects.toMatchObject({
          response: { code: FORM_GRID_MULTIPLE_CHOICE_SPLIT, itemId: 'q_extras' },
        });
        expect(formRepo.save).not.toHaveBeenCalled();
      });

      // A form saved before the rule must stay editable: refusing its stored grid would refuse an
      // edit of its title. Control: drop the `stored` argument in `update` -> the second test fails.
      it('refuses an edit that INTRODUCES the split on a stored form', async () => {
        const { service, formRepo } = makeService();
        jest
          .spyOn(service, 'assertFormManager')
          .mockResolvedValue(
            baseForm({ requiresPayment: true, items: [extras], priceMatrix: oneGroup }) as any
          );
        await expect(
          service.update('f1', { priceMatrix: twoGroups } as any, 'u1', false)
        ).rejects.toMatchObject({ response: { code: FORM_GRID_MULTIPLE_CHOICE_SPLIT } });
        expect(formRepo.save).not.toHaveBeenCalled();
      });

      it('saves an edit of another field on a form that already stores the split, and warns', async () => {
        const { service, formRepo } = makeService();
        jest
          .spyOn(service, 'assertFormManager')
          .mockResolvedValue(
            baseForm({ requiresPayment: true, items: [extras], priceMatrix: twoGroups }) as any
          );
        const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
        await service.update('f1', { title: 'Gala' } as any, 'u1', false);
        expect(formRepo.save).toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/\[FORM_GRID_SPLIT\] form f1 .*q_extras/)
        );
      });

      it('accepts every option in one group', async () => {
        const { service, formRepo } = makeService();
        await service.create(
          input({ requiresPayment: true, items: [extras], priceMatrix: oneGroup })
        );
        expect(formRepo.save).toHaveBeenCalled();
      });

      it('accepts two groups on a single-choice question', async () => {
        const { service, formRepo } = makeService();
        await service.create(
          input({
            requiresPayment: true,
            items: [{ ...extras, type: 'single_choice' }],
            priceMatrix: twoGroups,
          })
        );
        expect(formRepo.save).toHaveBeenCalled();
      });
    });

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

      // A grid by promo AND by menu: a guest is "everyone else" on the promo, and on the menu either
      // names an option or is "everyone else" there too (the true fallback).
      describe('on a grid by promo and by menu', () => {
        const both = (cells: Record<string, number | null>) => ({
          dimensions: [
            {
              id: 'dp',
              kind: 'promo',
              buckets: [{ id: 'p1', label: '1A', values: [2026] }],
            },
            {
              id: 'd1',
              kind: 'answer',
              questionId: 'q_menu',
              buckets: [{ id: 'b1', label: 'Menu', values: ['opt_a', 'opt_b'] }],
            },
          ],
          cells: {
            'p1|b1': 1000,
            'p1|_others': 1000,
            '_others|b1': 1200,
            '_others|_others': 1200,
            ...cells,
          },
        });

        it('accepts a NAMED option priced 0: a free choice, not a default', async () => {
          const { service, formRepo } = makeService();
          await service.create(
            input({
              requiresPayment: true,
              items: [menu({ required: false })],
              priceMatrix: both({ '_others|b1': 0 }),
            })
          );
          expect(formRepo.save).toHaveBeenCalled();
        });

        it('refuses the true fallback at 0: "everyone else" on every criterion', async () => {
          const { service, formRepo } = makeService();
          await expect(
            service.create(
              input({
                requiresPayment: true,
                items: [menu({ required: false })],
                priceMatrix: both({ '_others|_others': 0 }),
              })
            )
          ).rejects.toThrow(/"everyone else" price at 0/);
          expect(formRepo.save).not.toHaveBeenCalled();
        });
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

    // A guest's cash answer holds a seat and a place under the visitor ceiling until its deadline.
    // Controls (2026-10-22, WP-P3): the cash-deadline refusal removed -> the three refusals save;
    // the edit's deadline read with `??` again -> the explicit-null case saves; the refusal no longer
    // asking whether the form charges -> the free form is refused.
    it('refuses a public form that takes cash with no deadline', async () => {
      const { service, formRepo } = makeService();
      await expect(
        service.create(input({ requiresPayment: true, basePrice: 500, allowCashPayment: true }))
      ).rejects.toThrow(/needs a cash deadline/);
      expect(formRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to publish a stored cash setting with no deadline that the edit leaves out', async () => {
      const { service, formRepo } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(
        baseForm({
          isPublic: false,
          requiresPayment: true,
          basePrice: 500,
          allowCashPayment: true,
          cashPaymentExpiryDays: null,
        }) as any
      );
      await expect(
        service.update('f1', { isPublic: true, allowMultipleSubmissions: true } as any, 'u1', false)
      ).rejects.toThrow(/needs a cash deadline/);
      expect(formRepo.save).not.toHaveBeenCalled();
    });

    it('refuses an edit that clears the deadline of a public form taking cash', async () => {
      const { service, formRepo } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(
        baseForm({
          requiresPayment: true,
          basePrice: 500,
          allowCashPayment: true,
          cashPaymentExpiryDays: 3,
        }) as any
      );
      await expect(
        service.update('f1', { cashPaymentExpiryDays: null } as any, 'u1', false)
      ).rejects.toThrow(/needs a cash deadline/);
      expect(formRepo.save).not.toHaveBeenCalled();
    });

    it('does not ask a free public form for a cash deadline, whatever its old cash flag', async () => {
      const { service, formRepo } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(
        baseForm({
          requiresPayment: false,
          basePrice: 0,
          allowCashPayment: true,
          cashPaymentExpiryDays: null,
        }) as any
      );
      await service.update('f1', { title: 'Gala' } as any, 'u1', false);
      expect(formRepo.save).toHaveBeenCalled();
    });

    it('checks the stored flag when an edit leaves it out', async () => {
      const { service } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(baseForm() as any);
      await expect(
        service.update('f1', input({ isPublic: undefined, grantsCotisation: true }), 'u1', false)
      ).rejects.toThrow(BadRequestException);
    });

    // THE ORDER OF THE CLICKS CANNOT MATTER (owner, 2026-11-06): each pair is judged on the form as
    // it WILL be saved, the stored half merged with the edited half, so "public first, then X" and
    // "X first, then public" get the same answer. Control: pass the edit alone to
    // `assertFormOptionsCoherent` (as before WP-P1) and the refused "public last" cases save.
    describe('either order of the two switches', () => {
      const PUBLISH = { isPublic: true, allowMultipleSubmissions: true };
      const cases: [string, Record<string, unknown>, string | null][] = [
        ['a cotisation grant', { grantsCotisation: true }, 'FORM_PUBLIC_COTISATION_GRANT'],
        ['an audience condition', { submitCondition: { promo: [2026] } }, 'FORM_PUBLIC_AUDIENCE'],
        ['a grid on promo', { requiresPayment: true, priceMatrix: gridOn('promo') }, null],
      ];

      /** The code the edit is refused with, or null when it saved. */
      async function refusalCode(stored: Record<string, unknown>, edit: Record<string, unknown>) {
        const { service, formRepo } = makeService();
        jest.spyOn(service, 'assertFormManager').mockResolvedValue(baseForm(stored) as any);
        const code = await service
          .update('f1', edit as any, 'u1', false)
          .then(() => null)
          .catch((e: unknown) => {
            if (!(e instanceof BadRequestException)) throw e;
            return (e.getResponse() as { code?: string }).code ?? null;
          });
        expect(formRepo.save).toHaveBeenCalledTimes(code === null ? 1 : 0);
        return code;
      }

      it.each(cases)('public last, %s stored', async (_name, option, code) => {
        expect(await refusalCode({ isPublic: false, ...option }, PUBLISH)).toBe(code);
      });

      it.each(cases)('public first, %s added', async (_name, option, code) => {
        expect(await refusalCode(PUBLISH, option)).toBe(code);
      });

      // Stored before the supplement counted as a payment: `submit` refuses to charge it.
      const supplemented = [
        {
          id: 'q_menu',
          label: 'Menu',
          type: 'single_choice',
          options: [{ id: 'o1', label: 'Vin', priceModifier: 500 }],
        },
      ];
      const legacy = { isPublic: false, anonymous: true, items: supplemented };

      it('keeps a form stored with a conflict editable', async () => {
        expect(await refusalCode(legacy, { title: 'Gala 2027' })).toBeNull();
        expect(await refusalCode(legacy, { title: 'Gala', items: supplemented })).toBeNull();
      });

      it('still refuses an edit that introduces ANOTHER conflict on it', async () => {
        expect(await refusalCode(legacy, { grantsCotisation: true })).toBe(
          'FORM_ANONYMOUS_COTISATION_GRANT'
        );
      });
    });
  });

  // VERSION SKEW (forms.md, "A respondent changes their own answer"): an editor of 1.6.6 to 1.6.11
  // knows nothing of the switch, and its save must not turn it off behind the manager's back.
  describe('the answer-edit switch across an older editor', () => {
    /** What an older editor's save carries, as the ValidationPipe hands it on: no `allowAnswerEdit`. */
    const olderEditorSave = () =>
      plainToInstance(CreateFormDto, {
        title: 'Inscription au gala',
        description: 'Ouvert a tous',
        basePrice: 0,
        priceMatrix: null,
        submitCondition: null,
        currency: 'eur',
        items: [{ id: 'q1', label: 'Nom prenom', required: true, type: 'short_text' }],
        allowMultipleSubmissions: false,
        isPublic: false,
        guestFields: [],
        requiresPayment: false,
      });

    function stored() {
      const { service, formRepo } = makeService({
        form: baseForm({ isPublic: false, allowMultipleSubmissions: false, allowAnswerEdit: true }),
      });
      return { service, formRepo };
    }

    it('keeps the stored switch when the save does not carry it', async () => {
      const { service, formRepo } = stored();
      await service.update('f1', olderEditorSave(), 'u-owner', false);
      expect(formRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ allowAnswerEdit: true })
      );
    });

    it('turns it off only when a save says so', async () => {
      const { service, formRepo } = stored();
      await service.update(
        'f1',
        plainToInstance(CreateFormDto, { ...olderEditorSave(), allowAnswerEdit: false }),
        'u-owner',
        false
      );
      expect(formRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ allowAnswerEdit: false })
      );
    });
  });
});
