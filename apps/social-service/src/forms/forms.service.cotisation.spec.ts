import { BadRequestException } from '@nestjs/common';
import { FormsService } from './forms.service';
import type { CreateFormDto } from './dto/form.dto';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';

/**
 * The forms module had no test at all, and the path it lacked one for is the one that moves money
 * and grants membership. These cover the three seams migration 050 introduced:
 *
 *   - the config is refused at the moment it is chosen when the grant path could not honour it,
 *     instead of looking saved and doing nothing;
 *   - the member price asks the association's CURRENT tiers, so a form outlives an academic year;
 *   - a paid submission grants through `grantCotisant`, which derives the tag and revokes sibling
 *     tiers, and not through a raw `grantOrRenew` that would do neither.
 */
describe('FormsService - cotisation configuration and granting', () => {
  function makeService(
    opts: {
      tiers?: { variantKey: string | null; name: string; tagName: string }[];
      form?: Record<string, unknown> | null;
      submission?: Record<string, unknown> | null;
      /** Whether the caller holds MANAGE_MEMBERS - the right a cotisation grant demands. */
      mayGrant?: boolean;
      /** Cotisation tiers the submitter holds, for the pricing tests. */
      heldTiers?: (string | null)[];
    } = {}
  ) {
    const formRepo: any = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      findOne: jest.fn(() => Promise.resolve(opts.form ?? null)),
    };
    const submissionRepo: any = {
      count: jest.fn(() => Promise.resolve(0)),
      findOne: jest.fn(() => Promise.resolve(opts.submission ?? null)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const userTagService: any = {
      listCotisationTiers: jest.fn(() => Promise.resolve(opts.tiers ?? [])),
      holdsAnyCotisation: jest.fn(() => Promise.resolve(false)),
      holdsCotisationTier: jest.fn(() => Promise.resolve(false)),
      grantCotisant: jest.fn(() => Promise.resolve({})),
      grantOrRenew: jest.fn(() => Promise.resolve({})),
      hasActiveTag: jest.fn(() => Promise.resolve(false)),
    };
    const associationsService: any = {
      isMember: jest.fn(() => Promise.resolve(true)),
      assertPaymentsReady: jest.fn(() => Promise.resolve()),
      // MANAGE_MEMBERS by default, so the tests below are about the cotisation config itself;
      // the permission gate has its own block. `mayAct` is the one predicate every check asks -
      // it folds in the platform admin and the cross-association super-admin.
      mayAct: jest.fn(() => Promise.resolve(opts.mayGrant ?? true)),
      associationsWhereUserHasFlag: jest.fn(() => Promise.resolve([])),
      namesByIds: jest.fn(() => Promise.resolve(new Map())),
    };
    const purchaseRecordService: any = { create: jest.fn(() => Promise.resolve()) };
    // No grid and no profile criterion in this file, so the facts are the empty ones and no
    // cross-service call is expected. `forms.service.matrix.spec.ts` exercises the fetching.
    const submitterFacts: any = {
      build: jest.fn((input: { answers?: Record<string, string[]> }) =>
        Promise.resolve({
          promo: null,
          formation: null,
          cotisationTiers: opts.heldTiers ?? [],
          answers: input.answers ?? {},
          now: new Date('2026-08-23T12:00:00Z'),
        })
      ),
    };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      { findOne: jest.fn(), save: jest.fn() } as any,
      { get: jest.fn() } as any,
      associationsService,
      userTagService,
      purchaseRecordService,
      submitterFacts
    );
    return {
      service,
      formRepo,
      submissionRepo,
      userTagService,
      associationsService,
      submitterFacts,
    };
  }

  const CERCLE = [
    { variantKey: null, name: 'Cotisation', tagName: 'cotisant:cercle' },
    { variantKey: 'avec-alcool', name: 'Avec alcool', tagName: 'cotisant:cercle-avec-alcool' },
  ];
  /** An association that dropped its base product and sells named forfaits only. */
  const NAMED_ONLY = [
    { variantKey: 'avec-alcool', name: 'Avec alcool', tagName: 'cotisant:cercle-avec-alcool' },
  ];

  const dto = (over: Partial<CreateFormDto> = {}): CreateFormDto =>
    ({
      title: 'Inscription',
      basePrice: 1500,
      currency: 'eur',
      items: [],
      ownerId: 'user1',
      ...over,
    }) as CreateFormDto;

  describe('rejects a configuration the grant path could not honour', () => {
    it('refuses a grant with no beneficiary association', async () => {
      const { service } = makeService({ tiers: CERCLE });
      await expect(
        service.create(dto({ grantsCotisation: true, requiresPayment: true }))
      ).rejects.toThrow(BadRequestException);
    });

    // A submission whose total is zero is stored `free` and never reaches `markPaid`, so the grant
    // could not fire. This is not a policy: it is a setting with no code path behind it.
    it('refuses a grant on a form that does not require payment', async () => {
      const { service } = makeService({ tiers: CERCLE });
      await expect(
        service.create(dto({ grantsCotisation: true, associationId: 'asso1' }))
      ).rejects.toThrow(/require payment/i);
    });

    it('refuses a grant when the association sells no cotisation tier', async () => {
      const { service } = makeService({ tiers: [] });
      await expect(
        service.create(
          dto({ grantsCotisation: true, requiresPayment: true, associationId: 'asso1' })
        )
      ).rejects.toThrow(/no cotisation/i);
    });

    it('refuses a tier the association does not sell', async () => {
      const { service } = makeService({ tiers: CERCLE });
      await expect(
        service.create(
          dto({
            grantsCotisation: true,
            requiresPayment: true,
            associationId: 'asso1',
            cotisationVariantKey: 'sans-alcool',
          })
        )
      ).rejects.toThrow(/sans-alcool/);
    });

    // The base-tier trap `grantCotisant` guards, reached one step earlier: defaulting to the base
    // tier here would mint a tag no product grants and no gate checks.
    it('refuses a base-tier grant when the association has named tiers only', async () => {
      const { service } = makeService({ tiers: NAMED_ONLY });
      await expect(
        service.create(
          dto({ grantsCotisation: true, requiresPayment: true, associationId: 'asso1' })
        )
      ).rejects.toThrow(/no base tier/i);
    });

    it('refuses a pricing grid naming a tier the association does not sell', async () => {
      const { service } = makeService({ tiers: CERCLE });
      await expect(
        service.create(
          dto({
            associationId: 'asso1',
            priceMatrix: {
              dimensions: [
                {
                  id: 'd1',
                  kind: 'cotisation',
                  buckets: [{ id: 'b1', label: 'Cotisant', variantKeys: ['sans-alcool'] }],
                },
              ],
              cells: { b1: 800, _others: 2000 },
            },
          })
        )
      ).rejects.toThrow(/sans-alcool/);
    });

    it('accepts a valid named tier', async () => {
      const { service, formRepo } = makeService({ tiers: CERCLE });
      await service.create(
        dto({
          grantsCotisation: true,
          requiresPayment: true,
          associationId: 'asso1',
          cotisationVariantKey: 'avec-alcool',
        })
      );
      expect(formRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ grantsCotisation: true, cotisationVariantKey: 'avec-alcool' })
      );
    });

    // "Any tier" is stored as a reference, so it needs no tier named and cannot go stale when the
    // association adds a forfait.
    it('accepts a grid whose cotisation group takes any tier', async () => {
      const { service, formRepo } = makeService({ tiers: CERCLE });
      await service.create(
        dto({
          associationId: 'asso1',
          priceMatrix: {
            dimensions: [
              {
                id: 'd1',
                kind: 'cotisation',
                buckets: [{ id: 'b1', label: 'Cotisant', anyTier: true }],
              },
            ],
            cells: { b1: 800, _others: 2000 },
          },
        })
      );
      expect(formRepo.save).toHaveBeenCalled();
    });

    // The cheap path stays cheap: a form with no grant, no grid and no condition must not pay for a
    // catalogue lookup, and must not start failing because an association has no cotisation.
    it('does not look up any catalogue when nothing needs one', async () => {
      const { service, userTagService } = makeService({ tiers: [] });
      await service.create(dto({ associationId: 'asso1', requiresPayment: true }));
      expect(userTagService.listCotisationTiers).not.toHaveBeenCalled();
    });

    it('applies the same validation on update, not only on create', async () => {
      const { service } = makeService({
        tiers: CERCLE,
        form: { id: 'f1', ownerId: 'user1', items: [], associationId: 'asso1' },
      });
      await expect(
        service.update(
          'f1',
          dto({
            grantsCotisation: true,
            requiresPayment: true,
            associationId: 'asso1',
            cotisationVariantKey: 'sans-alcool',
          }),
          'user1',
          false
        )
      ).rejects.toThrow(/sans-alcool/);
    });
  });

  // Granting a cotisation from a form does exactly what the manual roster add does, so it demands
  // the same right. Creating a form needs only MEMBERSHIP of the association, which would otherwise
  // make a form a cheaper way to mint cotisants than the button that is guarded.
  describe('granting demands MANAGE_MEMBERS, not mere membership', () => {
    const grantDto = () =>
      dto({
        grantsCotisation: true,
        requiresPayment: true,
        associationId: 'asso1',
        cotisationVariantKey: 'avec-alcool',
      });

    it('refuses a member who cannot manage the association members', async () => {
      const { service } = makeService({ tiers: CERCLE, mayGrant: false });
      await expect(service.create(grantDto())).rejects.toThrow(/manage this association members/i);
    });

    it('checks MANAGE_MEMBERS, not MANAGE_FORMS', async () => {
      const { service, associationsService } = makeService({ tiers: CERCLE });
      await service.create(grantDto());
      expect(associationsService.mayAct).toHaveBeenCalledWith(
        'user1',
        'asso1',
        AssociationPermissionFlag.MANAGE_MEMBERS,
        { isGlobalAdmin: false }
      );
    });

    it('hands the admin header to the predicate rather than branching on it first', async () => {
      const { service, associationsService } = makeService({ tiers: CERCLE, mayGrant: true });
      await expect(service.create(grantDto(), true)).resolves.toBeDefined();
      expect(associationsService.mayAct).toHaveBeenCalledWith(
        'user1',
        'asso1',
        AssociationPermissionFlag.MANAGE_MEMBERS,
        { isGlobalAdmin: true }
      );
    });

    // A price grants nothing, so a grid stays open to any member. Gating it would stop an
    // association's ordinary members from making a form its cotisants can afford.
    it('does not gate a cotisation-based PRICE on MANAGE_MEMBERS', async () => {
      const { service, formRepo } = makeService({ tiers: CERCLE, mayGrant: false });
      await service.create(
        dto({
          requiresPayment: true,
          associationId: 'asso1',
          priceMatrix: {
            dimensions: [
              {
                id: 'd1',
                kind: 'cotisation',
                buckets: [{ id: 'b1', label: 'Cotisant', anyTier: true }],
              },
            ],
            cells: { b1: 800, _others: 2000 },
          },
        })
      );
      expect(formRepo.save).toHaveBeenCalled();
    });

    it('applies the same gate on update', async () => {
      const { service } = makeService({
        tiers: CERCLE,
        mayGrant: false,
        form: { id: 'f1', ownerId: 'user1', items: [], associationId: 'asso1' },
      });
      await expect(service.update('f1', grantDto(), 'user1', false)).rejects.toThrow(
        /manage this association members/i
      );
    });
  });

  // A form is personal or an association's, decided once at creation (user decision, 2026-08-23):
  // MANAGE_FORMS is a right over the association's forms, so cutting the link would let a manager
  // walk off with one, and re-pointing it would hand someone else's form to a third association.
  describe('the association link is fixed at creation', () => {
    const linked = () => ({
      id: 'f1',
      ownerId: 'user1',
      items: [],
      associationId: 'asso1',
    });

    it('refuses moving a form to another association', async () => {
      const { service } = makeService({ tiers: CERCLE, form: linked() });
      await expect(
        service.update('f1', dto({ associationId: 'asso2' }), 'user1', false)
      ).rejects.toThrow(/stays with the association/i);
    });

    it('refuses unlinking a form by sending an empty association', async () => {
      const { service } = makeService({ tiers: CERCLE, form: linked() });
      await expect(
        service.update('f1', dto({ associationId: '' }), 'user1', false)
      ).rejects.toThrow(/stays with the association/i);
    });

    it('refuses attaching an association to a personal form', async () => {
      const { service } = makeService({
        tiers: CERCLE,
        form: { ...linked(), associationId: null },
      });
      await expect(
        service.update('f1', dto({ associationId: 'asso1' }), 'user1', false)
      ).rejects.toThrow(/stays with the association/i);
    });

    it('accepts a save that repeats the same association', async () => {
      const { service, formRepo } = makeService({ tiers: CERCLE, form: linked() });
      await service.update('f1', dto({ associationId: 'asso1' }), 'user1', false);
      expect(formRepo.save).toHaveBeenCalled();
    });

    // An ABSENT field means "leave it alone", which is what the edit screen sends. Treating absence
    // as a request to unlink would refuse every save of a linked form.
    it('accepts a save that does not mention the association, and keeps it', async () => {
      const { service, formRepo } = makeService({ tiers: CERCLE, form: linked() });
      await service.update('f1', dto(), 'user1', false);
      expect(formRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ associationId: 'asso1' })
      );
    });
  });

  describe('granting on payment', () => {
    const paid = { id: 's1', formId: 'f1', userId: 'user1', totalPaid: 1500 };

    it('grants the configured tier through grantCotisant, never a raw tag', async () => {
      const { service, userTagService } = makeService({
        submission: { ...paid },
        form: {
          id: 'f1',
          title: 'Inscription',
          associationId: 'asso1',
          grantsCotisation: true,
          cotisationVariantKey: 'avec-alcool',
        },
      });

      await service.markPaid('s1', 'cs_test_1');

      expect(userTagService.grantCotisant).toHaveBeenCalledWith(
        'asso1',
        'user1',
        'system',
        'avec-alcool',
        { submissionId: 's1', sessionId: 'cs_test_1' }
      );
      // The old path called this directly with a tag string it had stored, which skipped both the
      // derivation and the sibling-tier revoke.
      expect(userTagService.grantOrRenew).not.toHaveBeenCalled();
    });

    it('grants the base tier when no tier is named', async () => {
      const { service, userTagService } = makeService({
        submission: { ...paid },
        form: {
          id: 'f1',
          associationId: 'asso1',
          grantsCotisation: true,
          cotisationVariantKey: null,
        },
      });

      await service.markPaid('s1');

      expect(userTagService.grantCotisant).toHaveBeenCalledWith(
        'asso1',
        'user1',
        'system',
        null,
        expect.objectContaining({ submissionId: 's1' })
      );
    });

    it('grants nothing when the form does not grant a cotisation', async () => {
      const { service, userTagService } = makeService({
        submission: { ...paid },
        form: { id: 'f1', associationId: 'asso1', grantsCotisation: false },
      });

      await service.markPaid('s1');

      expect(userTagService.grantCotisant).not.toHaveBeenCalled();
    });

    // The payment is already banked by the time this runs, so a grant failure must not unwind it -
    // but it must be shouted about, because the buyer will be told they are not a member.
    it('does not throw when the grant fails, and logs it as an error', async () => {
      const { service, userTagService } = makeService({
        submission: { ...paid },
        form: {
          id: 'f1',
          associationId: 'asso1',
          grantsCotisation: true,
          cotisationVariantKey: null,
        },
      });
      userTagService.grantCotisant.mockRejectedValue(new Error('db down'));
      const error = jest.spyOn(
        (service as unknown as { logger: { error: jest.Mock } }).logger,
        'error'
      );

      await expect(service.markPaid('s1')).resolves.toEqual({ ok: true });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to grant'),
        expect.any(Error)
      );
    });

    // The cash desk is the second grant site, and it had its own copy of the grant block. It
    // credits the validator rather than `system`, which is the whole reason the two are not one
    // call - and the reason a single shared helper has to take the granter as a parameter.
    it('credits the validator as the granter on the cash path', async () => {
      const { service, userTagService, formRepo, submissionRepo } = makeService();
      formRepo.findOne.mockResolvedValue({
        id: 'f1',
        ownerId: 'treasurer1',
        associationId: 'asso1',
        grantsCotisation: true,
        cotisationVariantKey: 'avec-alcool',
      });
      submissionRepo.findOne.mockResolvedValue({ ...paid, paymentStatus: 'pending_cash' });

      await service.validateCashPayment('f1', 's1', 'treasurer1', false);

      expect(userTagService.grantCotisant).toHaveBeenCalledWith(
        'asso1',
        'user1',
        'treasurer1',
        'avec-alcool',
        expect.objectContaining({ paymentMethod: 'cash', validatedBy: 'treasurer1' })
      );
    });

    // A cash submission validated twice must not renew the cotisation twice: the early return on a
    // status that is already `paid` is what stops it, and it sits above the grant.
    it('grants nothing when the cash submission was already processed', async () => {
      const { service, userTagService, formRepo, submissionRepo } = makeService();
      formRepo.findOne.mockResolvedValue({
        id: 'f1',
        ownerId: 'treasurer1',
        associationId: 'asso1',
        grantsCotisation: true,
        cotisationVariantKey: null,
      });
      submissionRepo.findOne.mockResolvedValue({ ...paid, paymentStatus: 'paid' });

      await service.validateCashPayment('f1', 's1', 'treasurer1', false);

      expect(userTagService.grantCotisant).not.toHaveBeenCalled();
    });
  });
});
