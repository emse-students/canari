import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { Subject, isObservable, of, throwError } from 'rxjs';
import { FindOperator, Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { COTISATION_TAG_COLLISION } from './cotisation-namespace';
import { ProductsService } from './products.service';
import { AssociationProduct } from './entities/association-product.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { ProductCheckout } from './entities/product-checkout.entity';
import { Association } from './entities/association.entity';
import { AssociationsService } from './associations.service';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { UserTagService } from '../users/user-tag.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordClosing } from '../users/entities/purchase-record-closing.entity';
import { associationVisibleTo } from '../spaces/viewer-visibility';

/**
 * Whether the buyer may see the product's association is one SQL predicate, proven against a real
 * PostgreSQL in `shop-partnership-visibility.integration.spec.ts`. Here every association is
 * visible unless a test says otherwise, and what is under test is that a purchase ASKS it.
 */
jest.mock('../spaces/viewer-visibility', () => ({
  associationVisibleTo: jest.fn(() => Promise.resolve(true)),
}));

/**
 * An in-memory `product_checkouts` keeping the two properties the service relies on: a conditional
 * `update` touches only the rows matching EVERY criterion (the `status = 'open'` guard), and a
 * second OPEN row for one product and buyer is refused with SQLSTATE 23505, as the partial unique
 * index `product_checkouts_one_open` refuses it. The transaction manager reads the same rows.
 */
/**
 * A transaction manager's `findOne` / `find`, routed by entity to the repository mocks, so a read
 * the service makes through its transaction (under the buyer's tier lock) answers what the test set
 * on the repository.
 */
function routeByEntity(repos: Map<unknown, { findOne: jest.Mock; find?: jest.Mock }>) {
  return {
    findOne: jest.fn((entity: unknown, opts: unknown) => {
      const repo = repos.get(entity);
      return repo ? repo.findOne(opts) : Promise.resolve(null);
    }),
    find: jest.fn((entity: unknown, opts: unknown) => {
      const repo = repos.get(entity);
      return repo?.find ? repo.find(opts) : Promise.resolve([]);
    }),
  };
}

function makeCheckoutStore(
  productRepo: { findOne: jest.Mock; find: jest.Mock },
  assoRepo: { findOne: jest.Mock; find: jest.Mock }
) {
  const rows: any[] = [];
  let next = 0;
  const matches = (row: any, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v instanceof FindOperator && v.type === 'isNull' ? row[k] == null : row[k] === v
    );
  /** The purchase records a settlement updates in its transaction; `setup` binds its own. */
  const records: { rows: any[] } = { rows: [] };
  const repo: any = {
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => {
      const clash = rows.some(
        (r) =>
          r !== x &&
          r.status === 'open' &&
          x.status === 'open' &&
          r.productId === x.productId &&
          r.userId === x.userId
      );
      if (clash) {
        throw Object.assign(new Error('duplicate key value (product_checkouts_one_open)'), {
          code: '23505',
        });
      }
      if (!x.id) {
        next += 1;
        x.id = `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
        // The column's DEFAULT now().
        x.createdAt = new Date();
        rows.push(x);
      }
      return x;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => matches(r, where)) ?? null
    ),
    update: jest.fn(async (where: Record<string, unknown>, patch: Record<string, unknown>) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    }),
  };
  const tx = {
    // The buyer's tier lock (`pg_advisory_xact_lock`): a no-op on one JavaScript thread; the
    // real serialisation is proven by product-tier-lock.integration.spec.ts.
    query: jest.fn((_sql: string, _params?: unknown[]) => Promise.resolve([])),
    save: jest.fn((_entity: unknown, x: any) => repo.save(x)),
    ...routeByEntity(
      new Map<unknown, { findOne: jest.Mock; find?: jest.Mock }>([
        [ProductCheckout, repo],
        [AssociationProduct, productRepo],
        [Association, assoRepo],
      ])
    ),
    update: jest.fn((entity: unknown, where: Record<string, unknown>, patch: any) => {
      if (entity === ProductCheckout) return repo.update(where, patch);
      const hit = records.rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ affected: hit.length });
    }),
  };
  repo.manager = { transaction: jest.fn((cb: (m: unknown) => unknown) => cb(tx)) };
  return { repo, rows, tx, records };
}

describe('ProductsService cotisation gating/pricing and Cercle re-gating', () => {
  function makeService() {
    const manager: any = {
      query: jest.fn(() => Promise.resolve([])),
      // Reads through a transaction answer what the repositories below answer.
      findOne: jest.fn((entity: unknown, opts: unknown) =>
        entity === AssociationProduct
          ? productRepo.findOne(opts)
          : entity === Association
            ? assoRepo.findOne(opts)
            : Promise.resolve(null)
      ),
      find: jest.fn((entity: unknown, opts: unknown) =>
        entity === AssociationProduct
          ? (productRepo.find as jest.Mock)(opts)
          : entity === Association
            ? (assoRepo.find as jest.Mock)(opts)
            : Promise.resolve([])
      ),
    };
    manager.transaction = jest.fn((cb: (m: unknown) => unknown) => cb(manager));
    // The release writes through its transaction (`releaseWithheldFor`, the holder share-locked).
    manager.update = jest.fn((entity: unknown, where: unknown, patch: unknown) =>
      entity === AssociationProduct
        ? (productRepo.update as jest.Mock)(where, patch)
        : Promise.resolve({ affected: 0 })
    );
    let withheldRows: Array<{ associationId: string }> = [];
    const productRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      update: jest.fn(() => Promise.resolve({ affected: 0 })),
      // The distinct-association query of the provider-activation sweep.
      createQueryBuilder: jest.fn(() => {
        const qb: any = {};
        for (const method of ['select', 'where', 'andWhere', 'orderBy', 'addOrderBy']) {
          qb[method] = jest.fn(() => qb);
        }
        qb.getRawMany = jest.fn(() => Promise.resolve(withheldRows));
        // The shop listing (`listAllActive`): answered by `find`, so each test states its rows in
        // one place. Which association is VISIBLE is SQL, proven against PostgreSQL in
        // `shop-partnership-visibility.integration.spec.ts`.
        qb.getMany = jest.fn(() => (productRepo.find as jest.Mock)({ where: { isActive: true } }));
        return qb;
      }),
      __setWithheld: (ids: string[]) => {
        withheldRows = ids.map((associationId) => ({ associationId }));
      },
      manager,
    };
    // Mirrors the real repo closely enough for the webhook dispatcher: `save` returns the entity
    // it was handed, and `findOne` answers with the last saved row (the audit record).
    let lastDelivery: any = null;
    // What `createQueryBuilder(...).getMany()` should answer. Chainable, because the service builds
    // its query fluently.
    let queryBuilderRows: any[] = [];
    const deliveryRepo = {
      create: jest.fn((x: any) => ({
        attemptCount: 0,
        autoRetryCount: 0,
        lastError: null,
        nextAttemptAt: null,
        ...x,
      })),
      save: jest.fn((x: any) => {
        lastDelivery = x;
        return Promise.resolve(x);
      }),
      findOne: jest.fn(() => Promise.resolve(lastDelivery)),
      remove: jest.fn(() => Promise.resolve()),
      manager,
      createQueryBuilder: jest.fn(() => {
        const qb: any = {};
        for (const method of ['where', 'andWhere', 'orderBy', 'take']) {
          qb[method] = jest.fn(() => qb);
        }
        qb.getMany = jest.fn(() => Promise.resolve(queryBuilderRows));

        return qb;
      }),
      __setRows: (rows: any[]) => {
        queryBuilderRows = rows;
      },
    };
    const assoRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      manager,
    };
    const httpService = {
      post: jest.fn(() => of({ data: {} })),
      // Active payment provider, polled via fetchActivePaymentProvider() - lydia by default,
      // matching the `asso()` factory below (lydiaAccountId/lydiaOnboardingComplete).
      get: jest.fn(() => of({ data: { provider: 'lydia' } })),
    } as unknown as HttpService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    const userTagService = {
      hasActiveTag: jest.fn(),
      hasActiveTagFromAnyIssuer: jest.fn(),
      getActiveTag: jest.fn(
        (
          _userId: string,
          _tagName: string,
          _issuer: string
        ): Promise<{ expiresAt: Date | null } | null> => Promise.resolve(null)
      ),
      listByUser: jest.fn(() => Promise.resolve([])),
      listHeldCotisationTiers: jest.fn(() => Promise.resolve([])),
      // No tag of a deleted tier unless a test says so (`OrphanTierTag[]`).
      heldOrphanTierTags: jest.fn(() => Promise.resolve([] as unknown[])),
      heldOrphanTierTagsOf: jest.fn(() => Promise.resolve(new Map())),
      countActiveTierHolders: jest.fn(() => Promise.resolve(0)),
      grantOrRenew: jest.fn(() => Promise.resolve({})),
      revokeByName: jest.fn(() => Promise.resolve()),
      revokeSiblingTierTags: jest.fn(() => Promise.resolve()),
    };
    const purchaseRecordService = {
      countPaidByUserAndProduct: jest.fn(() => Promise.resolve(0)),
      countPaidByProduct: jest.fn(() => Promise.resolve(0)),
      create: jest.fn((x: unknown) => Promise.resolve(x)),
      findByPaymentIntent: jest.fn(() => Promise.resolve(null)),
    };
    const associationsService = {
      uploadPublicImage: jest.fn(() => Promise.resolve('media1')),
      deleteMediaBestEffort: jest.fn(() => Promise.resolve()),
      revertLydiaReadinessAfterRefusal: jest.fn(() => Promise.resolve()),
    };
    // Only reached by a product carrying a pricing grid; the default fixtures carry none.
    const pricingFacts = {
      build: jest.fn(() =>
        Promise.resolve({ promo: null, formation: null, cotisationTiers: [], answers: {} })
      ),
      profileFor: jest.fn(() => Promise.resolve({ promo: null, formation: null })),
    };

    const checkouts = makeCheckoutStore(productRepo, assoRepo);

    const service = new ProductsService(
      productRepo as unknown as Repository<AssociationProduct>,
      deliveryRepo as unknown as Repository<WebhookDelivery>,
      assoRepo as unknown as Repository<Association>,
      httpService,
      config,
      userTagService as unknown as UserTagService,
      purchaseRecordService as unknown as PurchaseRecordService,
      associationsService as unknown as AssociationsService,
      pricingFacts as unknown as PricingFactsService,
      checkouts.repo as unknown as Repository<ProductCheckout>
    );

    return {
      service,
      pricingFacts,
      productRepo,
      deliveryRepo,
      assoRepo,
      httpService,
      userTagService,
      purchaseRecordService,
      associationsService,
      manager,
      checkouts,
    };
  }

  const asso = (overrides: Partial<Association> = {}): Association =>
    ({
      id: 'asso1',
      slug: 'bde',
      lydiaOnboardingComplete: true,
      lydiaAccountId: 'acct_1',
      cotisationEnabled: true,
      cotisationMode: 'lifetime',
      cotisationExpiresAt: null,
      ...overrides,
    }) as Association;

  const product = (overrides: Partial<AssociationProduct> = {}): AssociationProduct =>
    ({
      id: 'prod1',
      associationId: 'asso1',
      amountCents: 1000,
      currency: 'eur',
      type: 'other',
      isActive: true,
      allowRepeatPurchase: false,
      membersOnly: false,
      amountCentsMember: null,
      variantKey: null,
      variantLevel: null,
      memberPriceTag: null,
      requiredTags: null,
      allowCustomAmount: false,
      customAmountMinCents: null,
      customAmountMaxCents: null,
      ...overrides,
    }) as AssociationProduct;

  it('rejects a members-only purchase when the buyer is not a cotisant', async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ membersOnly: true }));
    userTagService.hasActiveTag.mockResolvedValue(false);

    await expect((service as any).resolvePurchase('asso1', 'prod1', 'user1')).rejects.toThrow(
      ForbiddenException
    );
    expect(userTagService.hasActiveTag).toHaveBeenCalledWith(
      'user1',
      'cotisant:bde',
      'asso1',
      expect.anything()
    );
  });

  it('allows a members-only purchase when the buyer holds the cotisation tag', async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ membersOnly: true }));
    userTagService.hasActiveTag.mockResolvedValue(true);

    const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
    expect(result.amountCents).toBe(1000);
  });

  it('charges the reduced member price when the buyer is a cotisant and amountCentsMember is set', async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ amountCentsMember: 500 }));
    userTagService.hasActiveTag.mockResolvedValue(true);

    const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
    expect(result.amountCents).toBe(500);
  });

  it('charges the full price when the buyer is not a cotisant even if amountCentsMember is set', async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ amountCentsMember: 500 }));
    userTagService.hasActiveTag.mockResolvedValue(false);

    const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
    expect(result.amountCents).toBe(1000);
  });

  describe('a free amount outside the product bounds', () => {
    const bounded = () =>
      product({
        amountCents: null,
        allowCustomAmount: true,
        customAmountMinCents: 100,
        customAmountMaxCents: 5000,
      });

    it('is refused with the typed code, both bounds, and a log line at the decision', async () => {
      const { service, productRepo, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(bounded());
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const err = await (service as any)
        .resolvePurchase('asso1', 'prod1', 'user1', 6000)
        .catch((e: unknown) => e);
      expect(err.getResponse()).toMatchObject({
        code: 'AMOUNT_OUT_OF_RANGE',
        minCents: 100,
        maxCents: 5000,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('amount=6000'));
    });

    it('CONTROL: an amount inside the bounds is accepted and logs no refusal', async () => {
      const { service, productRepo, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(bounded());
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1', 3000);
      expect(result.amountCents).toBe(3000);
      expect(warn).not.toHaveBeenCalled();
    });

    it('an unbounded maximum answers maxCents null', async () => {
      const { service, productRepo, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        product({
          amountCents: null,
          allowCustomAmount: true,
          customAmountMinCents: 100,
          customAmountMaxCents: null,
        })
      );
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const err = await (service as any)
        .resolvePurchase('asso1', 'prod1', 'user1', 50)
        .catch((e: unknown) => e);
      expect(err.getResponse()).toMatchObject({ minCents: 100, maxCents: null });
    });
  });

  it('derives the dated cotisation tag for member pricing/gating checks', async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'dated' }));
    productRepo.findOne.mockResolvedValue(product({ membersOnly: true }));
    userTagService.hasActiveTag.mockResolvedValue(true);

    await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
    const [, tagName] = userTagService.hasActiveTag.mock.calls[0];
    expect(tagName).toMatch(/^cotisant:bde-\d{4}-\d{4}$/);
  });

  describe('parent-payment delegation routing', () => {
    it('routes a delegating club purchase to the approved parent account', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const club = asso({
        id: 'club1',
        lydiaOnboardingComplete: false,
        lydiaAccountId: null,
        paymentParentAssociationId: 'parent1',
        paymentDelegationStatus: 'approved',
      });
      const parent = asso({
        id: 'parent1',
        lydiaOnboardingComplete: true,
        lydiaAccountId: 'acct_parent',
      });
      assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(id === 'parent1' ? parent : club)
      );
      productRepo.findOne.mockResolvedValue(product({ associationId: 'club1' }));
      userTagService.hasActiveTag.mockResolvedValue(false);

      const result = await (service as any).resolvePurchase('club1', 'prod1', 'user1');
      expect(result.paymentTarget.connectAccountId).toBe('acct_parent');
      expect(result.paymentTarget.delegated).toBe(true);
    });

    it('rejects a delegating club purchase when the parent has not completed onboarding', async () => {
      const { service, productRepo, assoRepo } = makeService();
      const club = asso({
        id: 'club1',
        lydiaOnboardingComplete: false,
        lydiaAccountId: null,
        paymentParentAssociationId: 'parent1',
        paymentDelegationStatus: 'approved',
      });
      const parent = asso({
        id: 'parent1',
        lydiaOnboardingComplete: false,
        lydiaAccountId: null,
      });
      assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(id === 'parent1' ? parent : club)
      );
      productRepo.findOne.mockResolvedValue(product({ associationId: 'club1' }));

      // The typed 409 (lot 2), the delegation carried for the payer's sentence.
      await expect(
        (service as any).resolvePurchase('club1', 'prod1', 'user1')
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'PAYMENTS_NOT_ACTIVATED', delegated: true },
      });
    });

    it('ignores a pending (unapproved) delegation and uses the club own account', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const club = asso({
        id: 'club1',
        lydiaOnboardingComplete: true,
        lydiaAccountId: 'acct_club',
        paymentParentAssociationId: 'parent1',
        paymentDelegationStatus: 'pending',
      });
      assoRepo.findOne.mockResolvedValue(club);
      productRepo.findOne.mockResolvedValue(product({ associationId: 'club1' }));
      userTagService.hasActiveTag.mockResolvedValue(false);

      const result = await (service as any).resolvePurchase('club1', 'prod1', 'user1');
      expect(result.paymentTarget.connectAccountId).toBe('acct_club');
      expect(result.paymentTarget.delegated).toBe(false);
    });
  });

  describe('cotisation config provisioning', () => {
    it('creates the canonical membership product when none exists', async () => {
      const { service, productRepo } = makeService();
      productRepo.find.mockResolvedValue([]);

      const created = await service.provisionCotisationProduct(asso());

      expect(productRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          associationId: 'asso1',
          type: 'membership',
          grantedTagName: 'cotisant:bde',
          tagExpiresAt: null,
          // CONTROL: payments are ready, so nothing is withheld.
          isActive: true,
          activationWithheld: false,
        })
      );
      expect(created).toBeDefined();
    });

    it('creates the canonical membership product WITHHELD when payments are not ready, so a release puts it on sale', async () => {
      const { service, productRepo } = makeService();
      productRepo.find.mockResolvedValue([]);

      await service.provisionCotisationProduct(
        asso({ lydiaOnboardingComplete: false, lydiaAccountId: null })
      );

      expect(productRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'membership', isActive: false, activationWithheld: true })
      );
    });

    it('re-syncs the tag on an existing canonical product without touching its name/price', async () => {
      const { service, productRepo } = makeService();
      const existing = product({
        type: 'membership',
        name: 'Cotisation BDE annuelle',
        amountCents: 2000,
        grantedTagName: 'cotisant:old-tag',
      });
      productRepo.find.mockResolvedValue([existing]);

      const result = await service.provisionCotisationProduct(asso());

      expect(result.grantedTagName).toBe('cotisant:bde');
      expect(result.name).toBe('Cotisation BDE annuelle');
      expect(result.amountCents).toBe(2000);
    });

    it("re-syncs every tier's own tag when an association has multiple membership products", async () => {
      const { service, productRepo } = makeService();
      const base = product({ id: 'prod1', type: 'membership', variantKey: null });
      const tier = product({
        id: 'prod2',
        type: 'membership',
        variantKey: 'avec-alcool',
        grantedTagName: 'cotisant:old-avec-alcool',
      });
      productRepo.find.mockResolvedValue([base, tier]);

      const result = await service.provisionCotisationProduct(asso());

      expect(base.grantedTagName).toBe('cotisant:bde');
      expect(tier.grantedTagName).toBe('cotisant:bde-avec-alcool');
      expect(result.id).toBe('prod1');
    });

    it('throws when cotisationMode is not set', async () => {
      const { service } = makeService();
      await expect(
        service.provisionCotisationProduct(asso({ cotisationMode: null }))
      ).rejects.toThrow('cotisationMode is required');
    });
  });

  describe('granted-tag rollover (dated mode)', () => {
    it('grants the freshly derived current-year tag, not the stored stale one', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'dated' }));
      const stale = product({
        type: 'membership',
        grantedTagName: 'cotisant:bde-2000-2001',
        tagExpiresAt: new Date('2001-08-31'),
      });

      const grant = await (service as any).resolveGrantTag(
        stale,
        (service as any).productRepo.manager
      );
      expect(grant.tagName).toMatch(/^cotisant:bde-\d{4}-\d{4}$/);
      expect(grant.tagName).not.toBe('cotisant:bde-2000-2001');
      expect(grant.expiresAt).toBeInstanceOf(Date);
    });

    it('grants NOTHING for a membership product without a cotisation mode: a stored tag is never granted as typed', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: null }));
      const legacy = product({
        type: 'membership',
        grantedTagName: 'cotisant:another-association',
        tagExpiresAt: null,
      });

      const grant = await (service as any).resolveGrantTag(
        legacy,
        (service as any).productRepo.manager
      );
      expect(grant).toBeNull();
    });

    it('an update never stores a typed grantedTagName on a membership product, and keeps it on another type', async () => {
      const { service, productRepo } = makeService();
      const tier = product({
        type: 'membership',
        grantedTagName: 'cotisant:bde',
        tagExpiresAt: null,
      });
      productRepo.findOne.mockResolvedValue(tier);

      await service.update(
        'asso1',
        'prod1',
        { grantedTagName: 'cotisant:another-association', tagExpiresAt: null } as never,
        false
      );
      expect(productRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ grantedTagName: 'cotisant:bde' })
      );

      const other = product({ type: 'other', grantedTagName: null });
      productRepo.findOne.mockResolvedValue(other);
      await service.update('asso1', 'prod1', { grantedTagName: 'vip:bde' } as never, false);
      expect(productRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ grantedTagName: 'vip:bde' })
      );
    });

    it('returns null for a non-membership product', async () => {
      const { service } = makeService();
      const grant = await (service as any).resolveGrantTag(
        product({ type: 'other' }),
        (service as any).productRepo.manager
      );
      expect(grant).toBeNull();
    });
  });

  describe('multi-tier membership creation (WP-COT-6)', () => {
    it("derives grantedTagName/tagExpiresAt server-side from the association's slug/mode + variantKey", async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));

      const created = await service.create(
        'asso1',
        { name: 'Avec alcool', type: 'membership', variantKey: 'avec-alcool' },
        false
      );

      expect(created.grantedTagName).toBe('cotisant:bde-avec-alcool');
      expect(created.tagExpiresAt).toBeNull();
    });

    it("refuses a tier whose key makes its tags coincide with another association's", async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));
      // Another association is slugged `bde-sport`: tier `sport` of `bde` would derive its tags.
      productRepo.manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          String(sql).includes('association_products')
            ? [{ slug: 'bde-sport', variantKey: null }]
            : []
        )
      );

      await expect(
        service.create('asso1', { name: 'Sport', type: 'membership', variantKey: 'sport' }, false)
      ).rejects.toMatchObject({ response: { code: COTISATION_TAG_COLLISION } });
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    // `cotisant:bde-2024-2025` is the base tier's dated tag: a tier keyed like a year could not be
    // told from it, and once deleted its holders would read as base holders, not as orphans.
    it('refuses a tier key shaped like an academic year, alone or as a suffix', async () => {
      for (const variantKey of ['2024-2025', 'gold-2024-2025']) {
        const { service, assoRepo, productRepo } = makeService();
        assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));
        await expect(
          service.create('asso1', { name: 'Year', type: 'membership', variantKey }, false)
        ).rejects.toMatchObject({ response: { code: 'TIER_KEY_YEAR_SHAPED' } });
        expect(productRepo.save).not.toHaveBeenCalled();
      }
      // CONTROL: a key holding digits that is not a year range is accepted.
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));
      await expect(
        service.create(
          'asso1',
          { name: 'Promo', type: 'membership', variantKey: 'promo-2024' },
          false
        )
      ).resolves.toBeDefined();
    });

    it('ignores any client-supplied grantedTagName for membership products', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));

      const created = await service.create(
        'asso1',
        { name: 'Base', type: 'membership', grantedTagName: 'cotisant:spoofed' },
        false
      );

      expect(created.grantedTagName).toBe('cotisant:bde');
    });

    it('derives a new tier key from its label when asked, free among the sibling tiers', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));
      const { manager } = productRepo;
      const steps: string[] = [];
      manager.query.mockImplementation((sql: string, params: unknown[]) => {
        steps.push(
          sql.includes('FROM associations a')
            ? 'stems'
            : sql.includes('FROM user_tags')
              ? `held ${JSON.stringify(params)}`
              : `${sql} ${JSON.stringify(params)}`
        );
        return Promise.resolve([]);
      });
      // The siblings are read on the TRANSACTION's manager, after the lock - never on the pool.
      manager.find.mockImplementation(() => {
        steps.push('find');
        return Promise.resolve([
          product({ id: 'base', type: 'membership', variantKey: null }),
          product({ id: 'other', type: 'membership', variantKey: 'avec-alcool' }),
        ]);
      });
      manager.save = jest.fn((_entity: unknown, row: unknown) => {
        steps.push('save');
        return Promise.resolve(row);
      });

      const created = await service.create(
        'asso1',
        { name: 'Avec Alcool', type: 'membership', deriveVariantKey: true },
        false
      );

      expect(created.variantKey).toBe('avec-alcool-2');
      expect(created.grantedTagName).toBe('cotisant:bde-avec-alcool-2');
      expect(created).not.toHaveProperty('deriveVariantKey');
      expect(steps).toEqual([
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) ["tier:asso1"]',
        'find',
        'stems',
        'held ["asso1","cotisant:bde-"]',
        'save',
      ]);
      expect(productRepo.find).not.toHaveBeenCalled();
    });

    it('skips a derived key whose tag a deleted tier still has active holders of', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'dated' }));
      const { manager } = productRepo;
      // "Avec alcool" was deleted; one holder still holds its dated tag, an orphan.
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('FROM user_tags') ? [{ tagName: 'cotisant:bde-avec-alcool-2026-2027' }] : []
        )
      );
      manager.find.mockResolvedValue([
        product({ id: 'base', type: 'membership', variantKey: null }),
      ]);
      manager.save = jest.fn((_entity: unknown, row: unknown) => Promise.resolve(row));

      const created = await service.create(
        'asso1',
        { name: 'Avec alcool', type: 'membership', deriveVariantKey: true },
        false
      );

      expect(created.variantKey).toBe('avec-alcool-2');
    });

    it('refuses with a typed 409 when every suffix of the derived key is taken', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));
      const { manager } = productRepo;
      manager.query.mockResolvedValue([]);
      manager.find.mockResolvedValue([
        product({ id: 't1', type: 'membership', variantKey: 'gold' }),
        ...Array.from({ length: 998 }, (_, i) =>
          product({ id: `t${i + 2}`, type: 'membership', variantKey: `gold-${i + 2}` })
        ),
      ]);
      manager.save = jest.fn();

      await expect(
        service.create('asso1', { name: 'Gold', type: 'membership', deriveVariantKey: true }, false)
      ).rejects.toMatchObject({ response: { code: 'TIER_KEY_EXHAUSTED' } });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('steps a derived key past another association stem instead of refusing it', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));
      const { manager } = productRepo;
      // Another association is slugged `bde-gold`: the stem `bde-gold` would derive its tags.
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('FROM associations a') ? [{ slug: 'bde-gold', variantKey: null }] : []
        )
      );
      manager.find.mockResolvedValue([
        product({ id: 'base', type: 'membership', variantKey: null }),
      ]);
      manager.save = jest.fn((_entity: unknown, row: unknown) => Promise.resolve(row));

      const created = await service.create(
        'asso1',
        { name: 'Gold', type: 'membership', deriveVariantKey: true },
        false
      );

      expect(created.variantKey).toBe('gold-2');
      expect(created.grantedTagName).toBe('cotisant:bde-gold-2');
    });

    it('derives a non-year-shaped key from a year-shaped label, so TIER_KEY_YEAR_SHAPED never answers a label', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'dated' }));
      const { manager } = productRepo;
      manager.query.mockResolvedValue([]);
      manager.find.mockResolvedValue([
        product({ id: 'base', type: 'membership', variantKey: null }),
      ]);
      manager.save = jest.fn((_entity: unknown, row: unknown) => Promise.resolve(row));

      const created = await service.create(
        'asso1',
        { name: 'Cotisation 2024-2025', type: 'membership', deriveVariantKey: true },
        false
      );

      expect(created.variantKey).toBe('cotisation');
      expect(created.grantedTagName).toMatch(/^cotisant:bde-cotisation-\d{4}-\d{4}$/);
    });

    it('refuses a derived tier when the slug leaves no room for a key in the tag', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'dated', slug: 's'.repeat(80) }));

      await expect(
        service.create(
          'asso1',
          { name: 'Avec alcool', type: 'membership', deriveVariantKey: true },
          false
        )
      ).rejects.toThrow(BadRequestException);
    });

    it('still honours an explicit variantKey (older clients) and refuses it with deriveVariantKey', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));

      await expect(
        service.create(
          'asso1',
          { name: 'Avec alcool', type: 'membership', variantKey: 'x', deriveVariantKey: true },
          false
        )
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create('asso1', { name: 'Goodies', type: 'other', deriveVariantKey: true }, false)
      ).rejects.toThrow(BadRequestException);
    });

    it('keeps the key and the tag when only the label changes - a rename moves nobody', async () => {
      const { service, productRepo } = makeService();
      const tierRow = product({
        id: 'tier1',
        type: 'membership',
        name: 'Avec alcool',
        variantKey: 'avec-alcool',
        grantedTagName: 'cotisant:bde-avec-alcool',
      });
      productRepo.findOne.mockResolvedValue(tierRow as never);

      const saved = await service.update('asso1', 'tier1', { name: 'Forfait bar' }, false);

      expect(saved.name).toBe('Forfait bar');
      expect(saved.variantKey).toBe('avec-alcool');
      expect(saved.grantedTagName).toBe('cotisant:bde-avec-alcool');
      expect(productRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it('rejects creating a membership tier when cotisation is not enabled', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: null }));

      await expect(
        service.create('asso1', { name: 'Avec alcool', type: 'membership' }, false)
      ).rejects.toThrow('Cotisation must be enabled');
    });
  });

  describe('Cercle balance_topup re-gating', () => {
    it('rejects creating a balance_topup product for a non-global-admin', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());

      await expect(
        service.create('asso1', { name: 'Recharge', type: 'balance_topup' }, false)
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a global admin to create a balance_topup product', async () => {
      const { service, productRepo, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());

      await service.create('asso1', { name: 'Recharge', type: 'balance_topup' }, true);
      expect(productRepo.save).toHaveBeenCalled();
    });

    // Found by the first live test top-up: the second one was refused with "You have already
    // purchased this product", and a real user would have hit it on their second recharge.
    it('makes a balance_topup product repeatable, on creation and on save', async () => {
      const { service, productRepo, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());

      await service.create('asso1', { name: 'Recharge', type: 'balance_topup' }, true);
      expect(productRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ allowRepeatPurchase: true })
      );

      productRepo.findOne.mockResolvedValue(
        product({ type: 'balance_topup', allowRepeatPurchase: false })
      );
      const updated = await service.update('asso1', 'prod1', { name: 'Recharge' }, true);
      expect(updated.allowRepeatPurchase).toBe(true);
    });

    it('rejects updating an existing balance_topup product for a non-global-admin', async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product({ type: 'balance_topup' }));

      await expect(service.update('asso1', 'prod1', { name: 'New name' }, false)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('allows a global admin to update an existing balance_topup product', async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product({ type: 'balance_topup' }));

      await service.update('asso1', 'prod1', { name: 'New name' }, true);
      expect(productRepo.save).toHaveBeenCalled();
    });

    it('does not require global admin for non-balance_topup product updates', async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product({ type: 'other' }));

      await expect(
        service.update('asso1', 'prod1', { name: 'New name' }, false)
      ).resolves.toBeDefined();
    });

    it('persists badgeText on update, and clears it with null', async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product({ type: 'other', badgeText: null }));

      const withBadge = await service.update('asso1', 'prod1', { badgeText: 'Nouveau' }, false);
      expect(withBadge.badgeText).toBe('Nouveau');

      productRepo.findOne.mockResolvedValue(product({ type: 'other', badgeText: 'Nouveau' }));
      const cleared = await service.update('asso1', 'prod1', { badgeText: null }, false);
      expect(cleared.badgeText).toBeNull();
    });
  });

  /** THE Cercle product: a repeatable, buyer-priced top-up with its webhook configured. */
  const topupProduct = (overrides: Partial<AssociationProduct> = {}) =>
    product({
      type: 'balance_topup',
      amountCents: null,
      allowCustomAmount: true,
      allowRepeatPurchase: true,
      customAmountMinCents: 100,
      customAmountMaxCents: 5000,
      webhookUrl: 'https://cercle.example/api/canari/topup',
      webhookSecret: 'shhh',
      ...overrides,
    } as Partial<AssociationProduct>);

  describe('a cash grant on a free-amount product', () => {
    const bounded = () =>
      product({
        type: 'other',
        amountCents: null,
        allowCustomAmount: true,
        customAmountMinCents: 100,
        customAmountMaxCents: 5000,
      });

    it('refuses an amount past the bounds with the typed code, both bounds, and a log line', async () => {
      const { service, productRepo, purchaseRecordService } = makeService();
      productRepo.findOne.mockResolvedValue(bounded());
      productRepo.manager.query.mockResolvedValue([{ id: 'user1' }]);
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const err = await service
        .grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1', amountCents: 6000 })
        .catch((e: unknown) => e);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'AMOUNT_OUT_OF_RANGE',
        minCents: 100,
        maxCents: 5000,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cash grant amount refused'));
      expect(purchaseRecordService.create).not.toHaveBeenCalled();
    });

    it('binds a maximum set with no minimum, as the checkout does', async () => {
      const { service, productRepo, purchaseRecordService } = makeService();
      productRepo.findOne.mockResolvedValue(
        product({
          type: 'other',
          amountCents: null,
          allowCustomAmount: true,
          customAmountMinCents: null,
          customAmountMaxCents: 5000,
        })
      );
      productRepo.manager.query.mockResolvedValue([{ id: 'user1' }]);
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const err = await service
        .grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1', amountCents: 6000 })
        .catch((e: unknown) => e);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'AMOUNT_OUT_OF_RANGE',
        minCents: 0,
        maxCents: 5000,
      });
      expect(purchaseRecordService.create).not.toHaveBeenCalled();
    });

    it('CONTROL: records an amount inside the bounds', async () => {
      const { service, productRepo, purchaseRecordService } = makeService();
      productRepo.findOne.mockResolvedValue(bounded());
      productRepo.manager.query.mockResolvedValue([{ id: 'user1' }]);
      purchaseRecordService.create.mockResolvedValue({
        id: 'rec1',
        userId: 'user1',
        source: 'product',
        productId: 'prod1',
        formId: null,
        productName: 'Sweat',
        amountCents: 3000,
        paymentMethod: 'cash',
        paidAt: new Date('2026-08-28T12:00:00Z'),
      });

      await service.grantProductPurchase('asso1', 'prod1', 'admin1', {
        userId: 'user1',
        amountCents: 3000,
      });
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethod: 'cash', amountCents: 3000 }),
        expect.anything()
      );
    });
  });

  describe('closing a payment paid and not granted (migration 113)', () => {
    /**
     * The tiers of the test association: `sans-alcool` (20 EUR) below `mid` (25 EUR) below
     * `avec-alcool` (30 EUR) below `top` (90 EUR), and `libre` with no fixed price.
     */
    const TIERS = [
      { id: 'prod-sans', associationId: 'asso1', variantKey: 'sans-alcool', amountCents: 2000 },
      { id: 'prod-mid', associationId: 'asso1', variantKey: 'mid', amountCents: 2500 },
      { id: 'prod-tier', associationId: 'asso1', variantKey: 'avec-alcool', amountCents: 3000 },
      { id: 'prod-top', associationId: 'asso1', variantKey: 'top', amountCents: 9000 },
      { id: 'prod-libre', associationId: 'asso1', variantKey: 'libre', amountCents: null },
    ].map((t) => ({ ...t, priceMatrix: null }));
    /** The catalogue listing every tier above. */
    const tagOf = (key: string) => `cotisant:cercle-${key}`;
    const FULL_CATALOGUE = TIERS.map((t) => ({
      variantKey: t.variantKey,
      name: t.variantKey,
      tagName: tagOf(t.variantKey),
    }));

    /**
     * A service whose purchase record lookups answer `records` in turn (the unlocked read, then the
     * locked one; the last one repeats) - and ONLY when asked within the record's own association, as
     * the real `where` does - with the association's catalogue `catalogue`, its mode, the tiers
     * the buyer holds now (`held`, by key), and the row of each held tag (`heldTag`; by default
     * granted long before any payment).
     */
    function closing(
      records: (Record<string, unknown> | null)[],
      opts: {
        closed?: boolean;
        catalogue?: { variantKey: string | null; name?: string }[];
        held?: string[];
        mode?: 'lifetime' | 'dated' | null;
        heldTag?: { createdAt: Date; metadata: Record<string, unknown> };
        stamps?: boolean;
      } = {}
    ) {
      const t = makeService();
      const base = t.manager.findOne;
      let read = 0;
      t.manager.findOne = jest.fn((entity: unknown, o: { where: { associationId?: string } }) => {
        if (entity !== PurchaseRecord) return base(entity, o);
        const record = records[Math.min(read++, records.length - 1)];
        return Promise.resolve(
          record && record.associationId === o.where.associationId ? record : null
        );
      });
      t.manager.insert = jest.fn(() => Promise.resolve({}));
      const first = records[0];
      (t.purchaseRecordService as any).closingsOf = jest.fn(() =>
        Promise.resolve(new Map(opts.closed && first ? [[first.id, { outcome: 'refunded' }]] : []))
      );
      (t.userTagService as any).grantCotisantWithin = jest.fn(() => Promise.resolve({}));
      (t.userTagService as any).listCotisationTiers = jest.fn(() =>
        Promise.resolve(
          opts.catalogue ?? [
            { variantKey: 'sans-alcool', name: 'Sans alcool', tagName: tagOf('sans-alcool') },
            { variantKey: 'avec-alcool', name: 'Avec alcool', tagName: tagOf('avec-alcool') },
          ]
        )
      );
      t.assoRepo.findOne.mockResolvedValue({
        id: 'asso1',
        slug: 'cercle',
        cotisationMode: opts.mode === undefined ? 'lifetime' : opts.mode,
      });
      (t.productRepo.find as jest.Mock).mockResolvedValue(TIERS);
      // The closing context reads the records' products by id: what `productRepo.findOne` answers.
      const baseFind = t.manager.find;
      t.manager.find = jest.fn(async (entity: unknown, o: { where: { id?: unknown } }) => {
        if (entity !== AssociationProduct || !o.where.id) return baseFind(entity, o);
        const product = await t.productRepo.findOne(o);
        return product ? [product] : [];
      });
      const held = new Set((opts.held ?? []).map(tagOf));
      t.userTagService.hasActiveTag.mockImplementation((_user: string, tag: string) =>
        Promise.resolve(held.has(tag))
      );
      const heldTag = {
        id: 'tag-1',
        ...(opts.heldTag ?? { createdAt: new Date(0), metadata: {} }),
      };
      (t.userTagService as any).stampDelivery = jest.fn(() => Promise.resolve(opts.stamps ?? true));
      (t.userTagService as any).activeTagsOf = jest.fn((userIds: string[], tagNames: string[]) =>
        Promise.resolve(
          tagNames
            .filter((tagName) => held.has(tagName))
            .map((tagName) => ({ ...heldTag, userId: userIds[0], tagName }))
        )
      );
      return t;
    }
    const marked = (over: Record<string, unknown> = {}) => ({
      id: 'rec-1',
      associationId: 'asso1',
      userId: 'user1',
      status: 'paid_not_granted',
      source: 'product',
      productId: 'prod-gone',
      formId: null,
      stripePaymentIntentId: '1001',
      paidAt: new Date(),
      ...over,
    });
    const codeOf = (e: unknown) =>
      ((e as ConflictException).getResponse() as { code: string }).code;
    const tierLocks = (t: ReturnType<typeof closing>) =>
      t.manager.query.mock.calls
        .filter(([sql]: [string]) =>
          String(sql).includes('pg_advisory_xact_lock(hashtextextended($1, 0))')
        )
        .map(([, params]: [string, unknown[]]) => params);
    const tierProduct = (variantKey = 'avec-alcool') =>
      product({
        id: TIERS.find((t) => t.variantKey === variantKey)!.id,
        type: 'membership',
        variantKey,
      });
    /** Closes as `granted` and answers the refusal, or undefined when it was granted. */
    const grantRefused = (t: ReturnType<typeof closing>, expectDelivered = false) =>
      t.service
        .closePaidNotGranted('asso1', 'rec-1', 'admin1', 'granted', expectDelivered)
        .then(() => undefined)
        .catch((e: unknown) => e);

    it("answers 404 for a record that is not this association's, and writes nothing", async () => {
      const t = closing([null]);
      await expect(
        t.service.closePaidNotGranted('asso1', 'rec-1', 'admin1', 'refunded', false)
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    it.each(['refunded', 'granted'] as const)(
      "answers 404 for association B's purchase named through association A (%s), and writes nothing",
      async (outcome) => {
        // The record exists - in asso1. Asked through asso2, every read is scoped to asso2.
        const t = closing([marked({ productId: 'prod-tier' })]);
        t.productRepo.findOne.mockResolvedValue(tierProduct());
        await expect(
          t.service.closePaidNotGranted('asso2', 'rec-1', 'admin1', outcome, false)
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(t.manager.insert).not.toHaveBeenCalled();
        expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
      }
    );

    it('refuses PURCHASE_NOT_CLOSABLE for a payment that is not marked', async () => {
      const t = closing([marked({ status: 'paid' })]);
      const err = await t.service
        .closePaidNotGranted('asso1', 'rec-1', 'admin1', 'refunded', false)
        .catch((e: unknown) => e);
      expect(codeOf(err)).toBe('PURCHASE_NOT_CLOSABLE');
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    it('refuses PURCHASE_ALREADY_CLOSED for a payment whose outcome is recorded', async () => {
      const t = closing([marked()], { closed: true });
      const err = await t.service
        .closePaidNotGranted('asso1', 'rec-1', 'admin1', 'refunded', false)
        .catch((e: unknown) => e);
      expect(codeOf(err)).toBe('PURCHASE_ALREADY_CLOSED');
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    it('answers PURCHASE_ALREADY_CLOSED for a violation of ITS unique index only', async () => {
      const t = closing([marked()]);
      const violation = (constraint: string) =>
        Object.assign(new Error('duplicate key'), { code: '23505', constraint });
      t.manager.insert.mockRejectedValueOnce(violation('purchase_record_closings_one_per_record'));
      const ours = await t.service
        .closePaidNotGranted('asso1', 'rec-1', 'admin1', 'refunded', false)
        .catch((e: unknown) => e);
      expect(codeOf(ours)).toBe('PURCHASE_ALREADY_CLOSED');

      t.manager.insert.mockRejectedValueOnce(violation('some_other_index'));
      const other = await t.service
        .closePaidNotGranted('asso1', 'rec-1', 'admin1', 'refunded', false)
        .catch((e: unknown) => e);
      expect(other).not.toBeInstanceOf(ConflictException);
    });

    it('refuses PURCHASE_TIER_GONE for GRANTED when the tier product was deleted, granting nothing', async () => {
      const t = closing([marked()]);
      t.productRepo.findOne.mockResolvedValue(null);
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_TIER_GONE');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['the association no longer sells cotisations', []],
      ['the tier is not in the catalogue', [{ variantKey: 'sans-alcool' }]],
    ])(
      'refuses PURCHASE_TIER_GONE, typed and not a 400, when %s',
      async (_case, catalogue: { variantKey: string | null }[]) => {
        const t = closing([marked({ productId: 'prod-tier' })], { catalogue });
        t.productRepo.findOne.mockResolvedValue(tierProduct());
        const err = await grantRefused(t);
        expect(err).toBeInstanceOf(ConflictException);
        expect(codeOf(err)).toBe('PURCHASE_TIER_GONE');
        expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
        expect(t.manager.insert).not.toHaveBeenCalled();
      }
    );

    it.each(['[deleted]', '[deleted]:0a1b2c3d'])(
      'refuses GRANTED for an ERASED buyer (%s), and still records REFUNDED for them',
      async (erasedId) => {
        const t = closing([marked({ userId: erasedId })]);
        expect(codeOf(await grantRefused(t))).toBe('PURCHASE_BUYER_ERASED');
        expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();

        const row = await t.service.closePaidNotGranted(
          'asso1',
          'rec-1',
          'admin1',
          'refunded',
          false
        );
        // The mocked closing read answers no closing, so the row reads as open: refunded-only.
        expect(row).toMatchObject({ grantRefusal: 'buyer-erased' });
        expect(t.manager.insert).toHaveBeenCalledTimes(1);
      }
    );

    it('refuses GRANTED when the erasure committed between the first read and the LOCKED one', async () => {
      const t = closing([marked({ productId: 'prod-tier' }), marked({ userId: '[deleted]' })]);
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_BUYER_ERASED');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    it('refuses PURCHASE_TARGET_ALREADY_HELD when the buyer held the tier paid for BEFORE paying: a refund is owed', async () => {
      const t = closing([marked({ productId: 'prod-tier' })], { held: ['avec-alcool'] });
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_TARGET_ALREADY_HELD');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    const later = () => new Date(Date.now() + 60_000);
    it.each([
      ['granted by hand after the payment (a roster grant)', { createdAt: later(), metadata: {} }],
      [
        "granted by this payment's own intent",
        { createdAt: new Date(0), metadata: { paymentIntentId: '1001' } },
      ],
    ])(
      'records GRANTED, grants nothing and stamps the tag when it is the delivery: %s',
      async (_case, heldTag) => {
        const t = closing([marked({ productId: 'prod-tier' })], { held: ['avec-alcool'], heldTag });
        t.productRepo.findOne.mockResolvedValue(tierProduct());
        expect(await grantRefused(t, true)).toBeUndefined();
        expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
        expect((t.userTagService as any).stampDelivery).toHaveBeenCalledWith(
          'tag-1',
          'rec-1',
          t.manager
        );
        expect(t.manager.insert).toHaveBeenCalledWith(
          PurchaseRecordClosing,
          expect.objectContaining({ purchaseRecordId: 'rec-1', outcome: 'granted' })
        );
      }
    );

    it.each([
      ['another payment granted it', { paymentIntentId: '2002', productId: 'prod-tier' }],
      ['it already closed another payment', { purchaseRecordId: 'rec-other' }],
      ['a form answer granted it, and this is a boutique payment', { submissionId: 'sub-1' }],
      ['a legacy claim granted it', { legacy: { batch: 'b' } }],
    ])(
      'refuses PURCHASE_TARGET_ALREADY_HELD when the tag points elsewhere, however recent: %s',
      async (_case, metadata) => {
        const t = closing([marked({ productId: 'prod-tier' })], {
          held: ['avec-alcool'],
          heldTag: { createdAt: later(), metadata },
        });
        t.productRepo.findOne.mockResolvedValue(tierProduct());
        expect(codeOf(await grantRefused(t))).toBe('PURCHASE_TARGET_ALREADY_HELD');
        expect((t.userTagService as any).stampDelivery).not.toHaveBeenCalled();
        expect(t.manager.insert).not.toHaveBeenCalled();
      }
    );

    it('refuses when the stamp finds the tag already the delivery of another payment', async () => {
      const t = closing([marked({ productId: 'prod-tier' })], {
        held: ['avec-alcool'],
        heldTag: { createdAt: later(), metadata: {} },
        stamps: false,
      });
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      expect(codeOf(await grantRefused(t, true))).toBe('PURCHASE_TARGET_ALREADY_HELD');
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    it('refuses PURCHASE_NOT_A_RISE when the buyer holds a dearer tier: granting would move them down', async () => {
      const t = closing([marked({ productId: 'prod-sans' })], { held: ['avec-alcool'] });
      t.productRepo.findOne.mockResolvedValue(tierProduct('sans-alcool'));
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_NOT_A_RISE');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
      expect(t.manager.insert).not.toHaveBeenCalled();
    });

    it('refuses PURCHASE_TIER_NOT_COMPARABLE, not NOT_A_RISE, for a tier with no fixed price', async () => {
      const t = closing([marked({ productId: 'prod-libre' })], {
        held: ['sans-alcool'],
        catalogue: FULL_CATALOGUE,
      });
      t.productRepo.findOne.mockResolvedValue(tierProduct('libre'));
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_TIER_NOT_COMPARABLE');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
    });

    // A tag of a deleted tier has no price: the closing ranks it as a checkout does, so granting
    // by hand cannot swap a deleted DEAR tier for a cheap one.
    it('refuses PURCHASE_HELD_TIER_DELETED, not NOT_COMPARABLE, when the buyer holds the tag of a DELETED tier', async () => {
      const t = closing([marked({ productId: 'prod-top' })], {
        held: [],
        catalogue: FULL_CATALOGUE,
      });
      t.productRepo.findOne.mockResolvedValue(tierProduct('top'));
      (t.userTagService as any).heldOrphanTierTagsOf.mockResolvedValue(
        new Map([['user1', [{ tagName: 'cotisant:bde-gone', variantKey: 'gone' }]]])
      );
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_HELD_TIER_DELETED');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
    });

    it('ranks a buyer holding TWO tiers against the DEARER: a tier between them is refused', async () => {
      const t = closing([marked({ productId: 'prod-mid' })], {
        held: ['sans-alcool', 'avec-alcool'],
        catalogue: FULL_CATALOGUE,
      });
      t.productRepo.findOne.mockResolvedValue(tierProduct('mid'));
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_NOT_A_RISE');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
    });

    it('grants a buyer holding TWO tiers a rise over the dearer, through the XOR grant path', async () => {
      const t = closing([marked({ productId: 'prod-top' })], {
        held: ['sans-alcool', 'avec-alcool'],
        catalogue: FULL_CATALOGUE,
      });
      t.productRepo.findOne.mockResolvedValue(tierProduct('top'));
      await t.service.closePaidNotGranted('asso1', 'rec-1', 'admin1', 'granted', false);
      // `grantCotisantWithin` is the manual path, whose sibling XOR revokes BOTH held tiers.
      expect((t.userTagService as any).grantCotisantWithin).toHaveBeenCalledWith(
        t.manager,
        'asso1',
        'user1',
        'admin1',
        'top',
        expect.anything()
      );
    });

    it('grants a dated tier paid in the CURRENT academic year', async () => {
      const t = closing([marked({ productId: 'prod-tier', paidAt: new Date() })], {
        mode: 'dated',
      });
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      await t.service.closePaidNotGranted('asso1', 'rec-1', 'admin1', 'granted', false);
      expect((t.userTagService as any).grantCotisantWithin).toHaveBeenCalledTimes(1);
    });

    it('still names the tier the buyer holds when the verdict stops early (tier gone)', async () => {
      const t = closing([marked()], { held: ['sans-alcool'] });
      t.productRepo.findOne.mockResolvedValue(null);
      (t.purchaseRecordService as any).listPaidByAssociation = jest.fn(() =>
        Promise.resolve([marked()])
      );
      const [row] = await t.service.listAssociationPurchases('asso1');
      expect(row).toMatchObject({ grantRefusal: 'tier-gone', buyerTier: 'Sans alcool' });
    });

    it('refuses PURCHASE_YEAR_OVER for a dated tier paid in an academic year that is over', async () => {
      const lastYear = new Date();
      lastYear.setFullYear(lastYear.getFullYear() - 1);
      const t = closing([marked({ productId: 'prod-tier', paidAt: lastYear })], { mode: 'dated' });
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      expect(codeOf(await grantRefused(t))).toBe('PURCHASE_YEAR_OVER');
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
    });

    it('records REFUNDED without the tier lock, grants nothing, and writes an audit line', async () => {
      const t = closing([marked()]);
      const log = jest.spyOn((t.service as any).logger, 'log').mockImplementation(() => undefined);
      const row = await t.service.closePaidNotGranted(
        'asso1',
        'rec-1',
        'admin1',
        'refunded',
        false
      );
      expect(t.manager.insert).toHaveBeenCalledWith(expect.anything(), {
        purchaseRecordId: 'rec-1',
        outcome: 'refunded',
        closedByUserId: 'admin1',
      });
      expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
      expect(row).toMatchObject({ id: 'rec-1', notGranted: true });
      expect(tierLocks(t)).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[AUDIT]'));
    });

    it("records GRANTED under the buyer's tier lock, granting the product's tier by hand", async () => {
      const t = closing([marked({ productId: 'prod-tier' })]);
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      await t.service.closePaidNotGranted('asso1', 'rec-1', 'admin1', 'granted', false);
      expect(tierLocks(t)).toEqual([['tier:asso1:user1']]);
      expect((t.userTagService as any).grantCotisantWithin).toHaveBeenCalledWith(
        t.manager,
        'asso1',
        'user1',
        'admin1',
        'avec-alcool',
        expect.objectContaining({ purchaseRecordId: 'rec-1', manualGrant: true })
      );
      expect(t.manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ outcome: 'granted' })
      );
    });

    it('records GRANTED for a RISE over the tier held', async () => {
      const t = closing([marked({ productId: 'prod-tier' })], { held: ['sans-alcool'] });
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      await t.service.closePaidNotGranted('asso1', 'rec-1', 'admin1', 'granted', false);
      expect((t.userTagService as any).grantCotisantWithin).toHaveBeenCalledTimes(1);
    });

    it("records GRANTED for a paid FORM by granting the form's tier", async () => {
      const t = closing([marked({ source: 'form', productId: null, formId: 'form-1' })]);
      const query = t.manager.query;
      t.manager.query = jest.fn((sql: string, params?: unknown[]) =>
        String(sql).includes('FROM forms')
          ? Promise.resolve([
              { id: 'form-1', grantsCotisation: true, cotisationVariantKey: 'avec-alcool' },
            ])
          : query(sql, params)
      );
      await t.service.closePaidNotGranted('asso1', 'rec-1', 'admin1', 'granted', false);
      expect((t.userTagService as any).grantCotisantWithin).toHaveBeenCalledWith(
        t.manager,
        'asso1',
        'user1',
        'admin1',
        'avec-alcool',
        expect.anything()
      );
    });

    it("lists an open marked payment with the buyer's CURRENT tier and why it cannot be granted", async () => {
      const t = closing([marked({ productId: 'prod-tier' })], { held: ['avec-alcool'] });
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      (t.purchaseRecordService as any).listPaidByAssociation = jest.fn(() =>
        Promise.resolve([marked({ productId: 'prod-tier' })])
      );
      const [row] = await t.service.listAssociationPurchases('asso1');
      expect(row).toMatchObject({ grantRefusal: 'target-held', buyerTier: 'Avec alcool' });
    });
    it.each([
      ['the tag names a NULL intent', { paymentIntentId: null }, '1001'],
      ['the record names no intent', { paymentIntentId: '1001' }, null],
      ['neither names an intent (null never matches null)', { paymentIntentId: null }, null],
    ])(
      'never falls back to time for a paid grant: refused when %s',
      async (_case, metadata, recordIntent) => {
        const t = closing(
          [marked({ productId: 'prod-tier', stripePaymentIntentId: recordIntent })],
          {
            held: ['avec-alcool'],
            heldTag: { createdAt: new Date(Date.now() + 60_000), metadata },
          }
        );
        t.productRepo.findOne.mockResolvedValue(tierProduct());
        expect(codeOf(await grantRefused(t))).toBe('PURCHASE_TARGET_ALREADY_HELD');
        expect(t.manager.insert).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['confirmed as delivered, and it no longer is', true, [] as string[]],
      ['confirmed as a grant, and it is now delivered', false, ['avec-alcool']],
    ])(
      'refuses PURCHASE_CLOSING_CHANGED when %s, writing nothing',
      async (_case, expectDelivered, held) => {
        const t = closing([marked({ productId: 'prod-tier' })], {
          held,
          heldTag: { createdAt: new Date(Date.now() + 60_000), metadata: {} },
        });
        t.productRepo.findOne.mockResolvedValue(tierProduct());
        const err = await t.service
          .closePaidNotGranted('asso1', 'rec-1', 'admin1', 'granted', expectDelivered)
          .catch((e: unknown) => e);
        expect(codeOf(err)).toBe('PURCHASE_CLOSING_CHANGED');
        expect((t.userTagService as any).grantCotisantWithin).not.toHaveBeenCalled();
        expect((t.userTagService as any).stampDelivery).not.toHaveBeenCalled();
        expect(t.manager.insert).not.toHaveBeenCalled();
      }
    );

    it('reads the closing context ONCE for all the open rows of the list', async () => {
      const t = closing([marked({ productId: 'prod-tier' })]);
      t.productRepo.findOne.mockResolvedValue(tierProduct());
      (t.purchaseRecordService as any).listPaidByAssociation = jest.fn(() =>
        Promise.resolve(
          ['rec-1', 'rec-2', 'rec-3'].map((id) => marked({ id, productId: 'prod-tier' }))
        )
      );
      const rows = await t.service.listAssociationPurchases('asso1');
      expect(rows).toHaveLength(3);
      expect((t.userTagService as any).listCotisationTiers).toHaveBeenCalledTimes(1);
      expect((t.userTagService as any).activeTagsOf).toHaveBeenCalledTimes(1);
    });
  });

  describe('the tier an opening freezes', () => {
    it('is the smallest product id when two tier products share the held key, said at WARN', () => {
      const { service } = makeService();
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const facts = {
        slug: 'cercle',
        tiers: [
          { id: 'prod-b', variantKey: 'avec' },
          { id: 'prod-a', variantKey: 'avec' },
          { id: 'prod-c', variantKey: 'sans' },
        ],
        heldKeys: ['avec'],
        held: { variantKey: 'avec', product: null },
      };
      expect((service as any).heldTierProductIdOf(facts)).toBe('prod-a');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('share key avec'));
    });
  });

  describe('a cash grant may not be recorded against a Cercle top-up', () => {
    it('refuses the grant, before touching the buyer or the books', async () => {
      const { service, productRepo, purchaseRecordService } = makeService();
      productRepo.findOne.mockResolvedValue(topupProduct());

      await expect(
        service.grantProductPurchase('asso1', 'prod1', 'admin1', {
          userId: 'user1',
          amountCents: 1000,
        })
      ).rejects.toThrow(BadRequestException);
      // The refusal is the point: a recorded line would read as a recharge that never reached the
      // Cercle, since a cash sale has no PaymentIntent to key the webhook on.
      expect(purchaseRecordService.create).not.toHaveBeenCalled();
    });

    it('still grants an ordinary product', async () => {
      const { service, productRepo, assoRepo, purchaseRecordService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(product({ type: 'other', amountCents: 500 }));
      productRepo.manager.query.mockResolvedValue([{ id: 'user1' }]);
      purchaseRecordService.create.mockResolvedValue({
        id: 'rec1',
        userId: 'user1',
        source: 'product',
        productId: 'prod1',
        formId: null,
        productName: 'Sweat',
        amountCents: 500,
        paymentMethod: 'cash',
        paidAt: new Date('2026-08-28T12:00:00Z'),
      });

      await service.grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1' });
      // Written inside the grant's transaction (the manager), so the tag and the record commit together.
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethod: 'cash', amountCents: 500 }),
        expect.anything()
      );
    });
  });

  describe('a cash sale records the price the checkout would charge its beneficiary (user, 2026-10-29)', () => {
    /** A fixed-price product whose preferential price goes to holders of the `sans-alcool` tier. */
    const setUp = (holdsLinkedTier: boolean) => {
      const made = makeService();
      made.assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle' }));
      made.productRepo.findOne.mockResolvedValue(
        product({
          amountCents: 1000,
          amountCentsMember: 300,
          memberPriceTag: 'cotisant:cercle-sans-alcool',
        })
      );
      made.productRepo.find.mockResolvedValue([
        product({ id: 'prod-sans', type: 'membership', variantKey: 'sans-alcool' }),
      ]);
      made.userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(holdsLinkedTier && tagName === 'cotisant:cercle-sans-alcool')
      );
      made.productRepo.manager.query.mockResolvedValue([{ id: 'user1' }]);
      made.purchaseRecordService.create.mockImplementation((x: unknown) =>
        Promise.resolve({ ...(x as object), id: 'rec1', paidAt: new Date('2026-10-29T12:00:00Z') })
      );
      return made;
    };

    it('records the preferential amount by default when the beneficiary qualifies', async () => {
      const { service, purchaseRecordService } = setUp(true);
      await service.grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1' });
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethod: 'cash', amountCents: 300 }),
        expect.anything()
      );
    });

    it("records the cashier's amount when one is given, over the preferential price", async () => {
      const { service, purchaseRecordService } = setUp(true);
      await service.grantProductPurchase('asso1', 'prod1', 'admin1', {
        userId: 'user1',
        amountCents: 1000,
      });
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethod: 'cash', amountCents: 1000 }),
        expect.anything()
      );
    });

    it('CONTROL: records the full price when the beneficiary does not qualify', async () => {
      const { service, purchaseRecordService } = setUp(false);
      await service.grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1' });
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethod: 'cash', amountCents: 1000 }),
        expect.anything()
      );
    });

    describe('the bounds of a free amount bind only an amount the cashier TYPES', () => {
      /** The review's repro: a member price below the free amount's minimum. */
      const boundedSetUp = () => {
        const made = setUp(true);
        made.productRepo.findOne.mockResolvedValue(
          product({
            amountCents: 1000,
            amountCentsMember: 300,
            memberPriceTag: 'cotisant:cercle-sans-alcool',
            allowCustomAmount: true,
            customAmountMinCents: 500,
          })
        );
        return made;
      };

      it('records the preferential default under the minimum, as the checkout charges it', async () => {
        const { service, purchaseRecordService } = boundedSetUp();
        await service.grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1' });
        expect(purchaseRecordService.create).toHaveBeenCalledWith(
          expect.objectContaining({ amountCents: 300 }),
          expect.anything()
        );
      });

      it('records a typed amount EQUAL to the quoted default as the default, unbounded', async () => {
        const { service, purchaseRecordService } = boundedSetUp();
        await service.grantProductPurchase('asso1', 'prod1', 'admin1', {
          userId: 'user1',
          amountCents: 300,
        });
        expect(purchaseRecordService.create).toHaveBeenCalledWith(
          expect.objectContaining({ amountCents: 300 }),
          expect.anything()
        );
      });

      it('CONTROL: still refuses a TYPED override under the minimum', async () => {
        const { service, purchaseRecordService } = boundedSetUp();
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        // 200: under the minimum (500) AND not the quoted 300, so it is a genuine override.
        const err = await service
          .grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1', amountCents: 200 })
          .catch((e: unknown) => e);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'AMOUNT_OUT_OF_RANGE',
        });
        expect(purchaseRecordService.create).not.toHaveBeenCalled();
      });
    });

    describe('the quote the cashier sees is what the sale records', () => {
      it('quotes the preferential price to a beneficiary who qualifies', async () => {
        const { service } = setUp(true);
        await expect(service.quoteCashSale('asso1', 'prod1', 'user1')).resolves.toEqual({
          kind: 'priced',
          amountCents: 300,
          preferential: true,
        });
      });

      it('quotes the full price to one who does not', async () => {
        const { service } = setUp(false);
        await expect(service.quoteCashSale('asso1', 'prod1', 'user1')).resolves.toEqual({
          kind: 'priced',
          amountCents: 1000,
          preferential: false,
        });
      });

      it('quotes `typed` for a free-amount product, which has no default', async () => {
        const { service, productRepo } = setUp(true);
        productRepo.findOne.mockResolvedValue(
          product({ amountCents: null, allowCustomAmount: true })
        );
        await expect(service.quoteCashSale('asso1', 'prod1', 'user1')).resolves.toEqual({
          kind: 'typed',
        });
      });

      it('answers 404 for a product of ANOTHER association', async () => {
        const { service, productRepo } = setUp(true);
        // The repository answers only the pair it is asked for: prod1 belongs to asso1.
        productRepo.findOne.mockImplementation(
          ({ where }: { where: { id: string; associationId: string } }) =>
            Promise.resolve(where.associationId === 'asso1' ? product() : null)
        );
        await expect(service.quoteCashSale('asso2', 'prod1', 'user1')).rejects.toThrow(
          NotFoundException
        );
      });

      it('answers 404 for a top-up, which has no cash sale', async () => {
        const { service, productRepo } = setUp(true);
        productRepo.findOne.mockResolvedValue(product({ type: 'balance_topup' }));
        await expect(service.quoteCashSale('asso1', 'prod1', 'user1')).rejects.toThrow(
          NotFoundException
        );
      });
    });
  });

  describe('webhook secret exposure and failed-delivery cleanup', () => {
    it('never returns the webhook secret, only whether one is set', async () => {
      const { service, productRepo } = makeService();
      productRepo.find.mockResolvedValue([
        product({ type: 'balance_topup', webhookSecret: 'shhh', webhookUrl: 'https://x/y' }),
      ]);

      const [listed] = await service.listAllByAssoc('asso1');
      expect(listed.webhookSecret).toBeNull();
      expect(listed.webhookConfigured).toBe(true);
      // The URL is the Cercle's public endpoint, and the admin page has to show it.
      expect(listed.webhookUrl).toBe('https://x/y');
    });

    it('refuses to delete a delivery belonging to another association', async () => {
      const { service, productRepo, deliveryRepo } = makeService();
      deliveryRepo.findOne.mockResolvedValue({ id: 'd1', productId: 'prod1', status: 'failed' });
      // The product does not resolve under the caller's association.
      productRepo.findOne.mockResolvedValue(null);

      await expect(service.deleteWebhookDelivery('other-asso', 'd1')).rejects.toThrow(
        NotFoundException
      );
      expect(deliveryRepo.remove).not.toHaveBeenCalled();
    });

    it('refuses to delete a delivered row, which records a real credit', async () => {
      const { service, productRepo, deliveryRepo } = makeService();
      deliveryRepo.findOne.mockResolvedValue({ id: 'd1', productId: 'prod1', status: 'delivered' });
      productRepo.findOne.mockResolvedValue(product({ type: 'balance_topup' }));

      await expect(service.deleteWebhookDelivery('asso1', 'd1')).rejects.toThrow(
        BadRequestException
      );
      expect(deliveryRepo.remove).not.toHaveBeenCalled();
    });

    it('deletes a failed delivery of its own association', async () => {
      const { service, productRepo, deliveryRepo } = makeService();
      const row = { id: 'd1', productId: 'prod1', status: 'failed', paymentIntentId: 'pi_x' };
      deliveryRepo.findOne.mockResolvedValue(row);
      productRepo.findOne.mockResolvedValue(product({ type: 'balance_topup' }));

      await service.deleteWebhookDelivery('asso1', 'd1');
      expect(deliveryRepo.remove).toHaveBeenCalledWith(row);
    });
  });

  describe('failed delivery retry, manual and automatic', () => {
    /** A row as the initial dispatch leaves it: three attempts burned, first backoff scheduled. */
    const failedRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'd1',
      productId: 'prod1',
      userId: 'user1',
      amountCents: 1500,
      paymentIntentId: 'pi_x',
      status: 'failed' as const,
      attemptCount: 3,
      autoRetryCount: 0,
      lastAttemptAt: new Date('2026-08-04T10:00:00Z'),
      nextAttemptAt: new Date('2026-08-04T10:05:00Z'),
      lastError: 'connect ECONNREFUSED',
      createdAt: new Date('2026-08-04T10:00:00Z'),
      ...overrides,
    });

    it('updates the row it was given instead of inserting a second one', async () => {
      // The whole reason the button looked dead: a successful retry used to leave the original
      // failure in the list and add a delivered row beside it.
      const { service, productRepo, deliveryRepo } = makeService();
      const row = failedRow();
      deliveryRepo.findOne.mockResolvedValue(row);
      productRepo.findOne.mockResolvedValue(topupProduct());

      const updated = await service.retryWebhookDelivery('asso1', 'd1');

      expect(deliveryRepo.create).not.toHaveBeenCalled();
      expect(updated.id).toBe('d1');
      expect(updated.status).toBe('delivered');
      expect(updated.nextAttemptAt).toBeNull();
    });

    it('sends exactly once, so the admin request cannot hang on the backoff ladder', async () => {
      const { service, productRepo, deliveryRepo, httpService } = makeService();
      deliveryRepo.findOne.mockResolvedValue(failedRow());
      productRepo.findOne.mockResolvedValue(topupProduct());
      (httpService.post as jest.Mock).mockImplementation(() => {
        throw new Error('502 Bad Gateway');
      });

      const updated = await service.retryWebhookDelivery('asso1', 'd1');

      expect((httpService.post as jest.Mock).mock.calls).toHaveLength(1);
      // Accumulated across the initial dispatch, not reset: this top-up has been sent four times.
      expect(updated.attemptCount).toBe(4);
      expect(updated.status).toBe('failed');
    });

    it('re-reads the product, so a corrected URL and secret are the ones used', async () => {
      const { service, productRepo, deliveryRepo, httpService } = makeService();
      deliveryRepo.findOne.mockResolvedValue(failedRow());
      productRepo.findOne.mockResolvedValue(
        topupProduct({ webhookUrl: 'https://fixed.example/api', webhookSecret: 'rotated' })
      );

      await service.retryWebhookDelivery('asso1', 'd1');

      const [url, , options] = (httpService.post as jest.Mock).mock.calls[0];
      expect(url).toBe('https://fixed.example/api');
      // Signed with the CURRENT secret: recomputing per attempt is what makes a rotation take
      // effect without touching the delivery row.
      const expected = createHmac('sha256', 'rotated')
        .update((httpService.post as jest.Mock).mock.calls[0][1])
        .digest('hex');
      expect(options.headers['X-Canari-Signature']).toBe(`sha256=${expected}`);
    });

    it('restarts the automatic ladder, because a manual retry means something was fixed', async () => {
      const { service, productRepo, deliveryRepo, httpService } = makeService();
      deliveryRepo.findOne.mockResolvedValue(failedRow({ autoRetryCount: 4 }));
      productRepo.findOne.mockResolvedValue(topupProduct());
      (httpService.post as jest.Mock).mockImplementation(() => {
        throw new Error('502 Bad Gateway');
      });

      const updated = await service.retryWebhookDelivery('asso1', 'd1');

      expect(updated.autoRetryCount).toBe(0);
      // Rescheduled rather than left exhausted, which is what an autoRetryCount of 4 would have
      // become after one more step.
      expect(updated.nextAttemptAt).not.toBeNull();
    });

    it('refuses a delivery belonging to another association', async () => {
      const { service, productRepo, deliveryRepo, httpService } = makeService();
      deliveryRepo.findOne.mockResolvedValue(failedRow());
      productRepo.findOne.mockResolvedValue(null);

      await expect(service.retryWebhookDelivery('other-asso', 'd1')).rejects.toThrow(
        NotFoundException
      );
      expect((httpService.post as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('retries every due delivery and reports what went through', async () => {
      const { service, productRepo, deliveryRepo } = makeService();
      deliveryRepo.__setRows([failedRow(), failedRow({ id: 'd2', paymentIntentId: 'pi_y' })]);
      productRepo.findOne.mockResolvedValue(topupProduct());

      const result = await service.retryDueWebhookDeliveries();

      expect(result).toEqual({ delivered: 2, attempted: 2 });
    });

    it('counts the automatic attempt before making it, and schedules the next step', async () => {
      const { service, productRepo, deliveryRepo, httpService } = makeService();
      const row = failedRow();
      deliveryRepo.__setRows([row]);
      productRepo.findOne.mockResolvedValue(topupProduct());
      (httpService.post as jest.Mock).mockImplementation(() => {
        throw new Error('502 Bad Gateway');
      });

      await service.retryDueWebhookDeliveries();

      // Counted first, so a crash mid-retry cannot leave the row looping on the same step.
      expect(row.autoRetryCount).toBe(1);
      expect(row.nextAttemptAt).not.toBeNull();
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('takes a row off the ladder once the backoff steps run out', async () => {
      const { service, productRepo, deliveryRepo, httpService } = makeService();
      // One short of the last step: this attempt is the final one.
      const row = failedRow({ autoRetryCount: 4 });
      deliveryRepo.__setRows([row]);
      productRepo.findOne.mockResolvedValue(topupProduct());
      (httpService.post as jest.Mock).mockImplementation(() => {
        throw new Error('502 Bad Gateway');
      });

      await service.retryDueWebhookDeliveries();

      // Null means "a human has to look at this", which is what the admin list is for. Retrying
      // forever would only hide a configuration problem.
      expect(row.nextAttemptAt).toBeNull();
      expect(row.status).toBe('failed');
    });

    it('stops retrying a delivery whose product lost its webhook configuration', async () => {
      const { service, productRepo, deliveryRepo, httpService } = makeService();
      const row = failedRow();
      deliveryRepo.__setRows([row]);
      productRepo.findOne.mockResolvedValue(topupProduct({ webhookUrl: null }));

      const result = await service.retryDueWebhookDeliveries();

      expect((httpService.post as jest.Mock).mock.calls).toHaveLength(0);
      expect(row.nextAttemptAt).toBeNull();
      expect(row.lastError).toContain('not configured');
      expect(result).toEqual({ delivered: 0, attempted: 1 });
    });

    it('names the member a failed delivery is about', async () => {
      const { service, productRepo, deliveryRepo, manager } = makeService();
      productRepo.find.mockResolvedValue([{ id: 'prod1', name: 'Recharge Cercle' }]);
      deliveryRepo.__setRows([failedRow()]);
      manager.query.mockResolvedValue([{ id: 'user1', firstName: 'Camille', lastName: 'Durand' }]);

      const [listed] = await service.listWebhookFailures('asso1');

      // The uuids alone told an admin nothing about whose money is stuck.
      expect(listed.firstName).toBe('Camille');
      expect(listed.lastName).toBe('Durand');
      expect(listed.productName).toBe('Recharge Cercle');
      expect(listed.nextAttemptAt).toBe('2026-08-04T10:05:00.000Z');
    });

    it('leaves the name null when the account no longer exists', async () => {
      const { service, productRepo, deliveryRepo, manager } = makeService();
      productRepo.find.mockResolvedValue([{ id: 'prod1', name: 'Recharge Cercle' }]);
      deliveryRepo.__setRows([failedRow()]);
      manager.query.mockResolvedValue([]);

      const [listed] = await service.listWebhookFailures('asso1');

      // A deleted account is a different problem from a Cercle-side failure, and the UI has to be
      // able to tell them apart - so no placeholder name is invented here.
      expect(listed.firstName).toBeNull();
      expect(listed.userId).toBe('user1');
    });
  });

  describe('multi-tier upgrade pricing via memberPriceTag (WP-COT-2)', () => {
    it('applies the member price when the buyer holds the named memberPriceTag, even without the generic tag', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle' }));
      productRepo.findOne.mockResolvedValue(
        product({ amountCentsMember: 300, memberPriceTag: 'cotisant:cercle-sans-alcool' })
      );
      // The tag names a TIER of the association, which is what the link is read as.
      productRepo.find.mockResolvedValue([
        product({ id: 'prod-sans', type: 'membership', variantKey: 'sans-alcool' }),
      ]);
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === 'cotisant:cercle-sans-alcool')
      );

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(300);
      expect(userTagService.hasActiveTag).toHaveBeenCalledWith(
        'user1',
        'cotisant:cercle-sans-alcool',
        'asso1',
        expect.anything()
      );
    });

    it('does not fall back to the generic cotisant tag when memberPriceTag is set but not held', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle' }));
      productRepo.findOne.mockResolvedValue(
        product({ amountCentsMember: 300, memberPriceTag: 'cotisant:cercle-sans-alcool' })
      );
      // Buyer holds the generic asso tag, but not the specific sibling-tier tag required here.
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === 'cotisant:cercle')
      );

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(1000);
    });
  });

  describe('tier-specific grant tag (WP-COT-2)', () => {
    it('suffixes the granted tag with the product variantKey', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      const tiered = product({
        type: 'membership',
        grantedTagName: 'cotisant:cercle-avec-alcool',
        variantKey: 'avec-alcool',
      });

      const grant = await (service as any).resolveGrantTag(
        tiered,
        (service as any).productRepo.manager
      );
      expect(grant.tagName).toBe('cotisant:cercle-avec-alcool');
    });
  });

  describe('assertCanPurchase: a balance top-up is never capped', () => {
    it('lets a top-up be re-bought even when the stored row says otherwise', async () => {
      const { service, purchaseRecordService } = makeService();
      // A row created before the forcing landed: repeat purchase off, both caps already reached.
      purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(3);
      purchaseRecordService.countPaidByProduct.mockResolvedValue(3);
      const topup = product({
        type: 'balance_topup',
        allowRepeatPurchase: false,
        maxPurchasesPerUser: 1,
        maxPurchasesTotal: 1,
      });

      await expect(
        (service as any).assertCanPurchase(
          topup,
          'user1',
          true,
          (service as any).productRepo.manager
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('assertCanPurchase: same-tier rebuy blocked / sibling switch allowed (WP-COT-2)', () => {
    it('blocks re-buying the same tier while its tag is still active', async () => {
      const { service, assoRepo, purchaseRecordService, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(1);
      userTagService.hasActiveTag.mockResolvedValue(true);
      const avecAlcool = product({
        type: 'membership',
        grantedTagName: 'cotisant:cercle-avec-alcool',
        variantKey: 'avec-alcool',
      });

      await expect(
        (service as any).assertCanPurchase(
          avecAlcool,
          'user1',
          true,
          (service as any).productRepo.manager
        )
      ).rejects.toThrow('You have already purchased this product');
    });

    it('allows buying the sibling tier product even after purchasing another tier', async () => {
      const { service, purchaseRecordService } = makeService();
      // Purchase history is tracked per-product, so the buyer's prior "avec-alcool" purchase
      // does not count against a first purchase of the sibling "sans-alcool" product.
      purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(0);
      const sansAlcool = product({
        type: 'membership',
        grantedTagName: 'cotisant:cercle-sans-alcool',
        variantKey: 'sans-alcool',
      });

      await expect(
        (service as any).assertCanPurchase(
          sansAlcool,
          'user1',
          true,
          (service as any).productRepo.manager
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('XOR sibling-tier revoke on fulfillment (WP-COT-2)', () => {
    it('grants the new tier tag and revokes the other tiers in the same transaction', async () => {
      const { service, assoRepo, userTagService, manager } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      const avecAlcool = product({
        id: 'prod-avec',
        type: 'membership',
        grantedTagName: 'cotisant:cercle-avec-alcool',
        variantKey: 'avec-alcool',
      });

      await (service as any).fulfillProductPurchase({
        product: avecAlcool,
        userId: 'user1',
        amountCents: 1000,
        paymentMethod: 'cash',
        stripePaymentIntentId: null,
        grantedBy: 'admin1',
        dispatchWebhook: false,
      });

      expect(userTagService.grantOrRenew).toHaveBeenCalledWith(
        expect.objectContaining({ tagName: 'cotisant:cercle-avec-alcool' }),
        manager
      );
      // The XOR itself lives in UserTagService (one implementation shared with the manual
      // grant); fulfillment's contract is to invoke it for the bought tier, inside the tx.
      expect(userTagService.revokeSiblingTierTags).toHaveBeenCalledWith(
        'asso1',
        'user1',
        'avec-alcool',
        manager
      );
    });

    it('delegates the XOR for a base-tier product too, so a named tier cannot linger', async () => {
      const { service, assoRepo, userTagService, manager } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'bde', cotisationMode: 'lifetime' }));
      const single = product({ type: 'membership', grantedTagName: 'cotisant:bde' });

      await (service as any).fulfillProductPurchase({
        product: single,
        userId: 'user1',
        amountCents: 1000,
        paymentMethod: 'cash',
        stripePaymentIntentId: null,
        grantedBy: 'admin1',
        dispatchWebhook: false,
      });

      expect(userTagService.revokeSiblingTierTags).toHaveBeenCalledWith(
        'asso1',
        'user1',
        null,
        manager
      );
    });
  });

  describe('requiredTags gating (WP-COT-3)', () => {
    it('rejects a purchase when requiredTags is set and the buyer holds none of them', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(product({ requiredTags: ['tag:a', 'tag:b'] }));
      userTagService.hasActiveTagFromAnyIssuer.mockResolvedValue(false);

      await expect((service as any).resolvePurchase('asso1', 'prod1', 'user1')).rejects.toThrow(
        ForbiddenException
      );
    });

    it('allows a purchase when the buyer holds ANY of the requiredTags', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(product({ requiredTags: ['tag:a', 'tag:b'] }));
      userTagService.hasActiveTagFromAnyIssuer.mockImplementation(
        (_userId: string, tagName: string) => Promise.resolve(tagName === 'tag:b')
      );

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(1000);
    });

    it('takes precedence over membersOnly: a non-cotisant holding a required tag can still buy', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        product({ membersOnly: true, requiredTags: ['tag:vip'] })
      );
      // Buyer holds neither the association's base cotisant tag nor any tier - only tag:vip.
      userTagService.hasActiveTagFromAnyIssuer.mockImplementation(
        (_userId: string, tagName: string) => Promise.resolve(tagName === 'tag:vip')
      );

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(1000);
    });
  });

  describe('membersOnly any-tier back-compat (WP-COT-3)', () => {
    it('allows a members-only purchase when the buyer holds a sibling tier tag, not the base tag', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      const avecAlcool = product({
        id: 'prod-avec',
        type: 'membership',
        variantKey: 'avec-alcool',
      });
      const sansAlcool = product({
        id: 'prod-sans',
        type: 'membership',
        variantKey: 'sans-alcool',
      });
      const goodies = product({ id: 'prod-goodies', membersOnly: true });
      // isBuyerCotisant enumerates the association's tiered membership products.
      productRepo.find.mockResolvedValue([avecAlcool, sansAlcool]);
      productRepo.findOne.mockResolvedValue(goodies);
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === 'cotisant:cercle-sans-alcool')
      );

      const result = await (service as any).resolvePurchase('asso1', 'prod-goodies', 'user1');
      expect(result.amountCents).toBe(1000);
    });

    it('rejects a members-only purchase when the buyer holds none of the association tiers', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      const avecAlcool = product({
        id: 'prod-avec',
        type: 'membership',
        variantKey: 'avec-alcool',
      });
      const sansAlcool = product({
        id: 'prod-sans',
        type: 'membership',
        variantKey: 'sans-alcool',
      });
      const goodies = product({ id: 'prod-goodies', membersOnly: true });
      productRepo.find.mockResolvedValue([avecAlcool, sansAlcool]);
      productRepo.findOne.mockResolvedValue(goodies);
      userTagService.hasActiveTag.mockResolvedValue(false);

      await expect(
        (service as any).resolvePurchase('asso1', 'prod-goodies', 'user1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('listAllActive viewerIsCotisant/viewerActiveTier (WP-COT-3)', () => {
    it("annotates products with the viewer's active tier across a multi-tier association", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const cercle = asso({ id: 'asso1', slug: 'cercle', cotisationMode: 'lifetime' });
      const avecAlcool = product({
        id: 'prod-avec',
        associationId: 'asso1',
        type: 'membership',
        variantKey: 'avec-alcool',
      });
      const sansAlcool = product({
        id: 'prod-sans',
        associationId: 'asso1',
        type: 'membership',
        variantKey: 'sans-alcool',
      });
      productRepo.find
        .mockResolvedValueOnce([avecAlcool, sansAlcool]) // listAllActive's own products query
        .mockResolvedValueOnce([avecAlcool, sansAlcool]); // cotisantStatusFor's tier query
      assoRepo.find.mockResolvedValue([cercle]);
      userTagService.listByUser.mockResolvedValue([
        { tagName: 'cotisant:cercle-sans-alcool', issuingAssocId: 'asso1' },
      ]);

      const result = await service.listAllActive('user1');

      const sans = result.find((p) => p.id === 'prod-sans')!;
      const avec = result.find((p) => p.id === 'prod-avec')!;
      expect(sans.viewerIsCotisant).toBe(true);
      expect(sans.viewerActiveTier).toBe('sans-alcool');
      // Both products of the same association share the viewer's association-level status.
      expect(avec.viewerIsCotisant).toBe(true);
      expect(avec.viewerActiveTier).toBe('sans-alcool');
    });

    it('returns viewerIsCotisant=false and viewerActiveTier=null when the viewer holds no tag', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const bde = asso({ id: 'asso1', slug: 'bde', cotisationMode: 'lifetime' });
      const membership = product({ id: 'prod1', associationId: 'asso1', type: 'membership' });
      productRepo.find.mockResolvedValueOnce([membership]).mockResolvedValueOnce([membership]);
      assoRepo.find.mockResolvedValue([bde]);
      userTagService.listByUser.mockResolvedValue([]);

      const [result] = await service.listAllActive('user1');
      expect(result.viewerIsCotisant).toBe(false);
      expect(result.viewerActiveTier).toBeNull();
    });
  });

  /**
   * THE SHOP IS CLOSED TO A REVIEW ACCOUNT (review-cohort-reach.ts, owner 2026-10-31: "Tout
   * fermer"): it sees and buys only what an association it is a member of sells, and a review
   * account is a member of no real one. A member is not restricted (the cases above).
   */
  describe('the review cohort', () => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    beforeEach(() => {
      process.env.SERVICE_ACCOUNT_USER_ID = 'user1';
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    });

    it("lists nothing of a real association to a review account, and its own association's products", async () => {
      const { service, productRepo, assoRepo, manager } = makeService();
      const items = [
        product({ id: 'real', associationId: 'asso1' }),
        product({ id: 'demo', associationId: 'asso-demo' }),
      ];
      productRepo.find.mockResolvedValue(items);
      assoRepo.find.mockResolvedValue([asso(), asso({ id: 'asso-demo', slug: 'demo' })]);
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('FROM association_members') ? [{ associationId: 'asso-demo' }] : []
        )
      );

      const listed = await service.listAllActive('user1');
      expect(listed.map((p) => p.id)).toEqual(['demo']);
    });

    it('refuses a review account a checkout on a real association, typed, before anything is read', async () => {
      const { service, productRepo } = makeService();
      const err = await service
        .createCheckoutSession('asso1', 'prod1', 'user1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'REVIEW_COHORT_BOUNDARY',
      });
      expect(productRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('a tier is bought only as a RISE over the tier held (user, 2026-10-26)', () => {
    // Production's two Cercle tiers: no grid, no variantLevel; the dearer one carries the admin's
    // preferential price for holders of the cheaper one.
    const cercle = () => asso({ id: 'asso1', slug: 'cercle', cotisationMode: 'lifetime' });
    const sansAlcool = (overrides: Partial<AssociationProduct> = {}) =>
      product({
        id: 'prod-sans',
        type: 'membership',
        variantKey: 'sans-alcool',
        amountCents: 1500,
        ...overrides,
      });
    const avecAlcool = (overrides: Partial<AssociationProduct> = {}) =>
      product({
        id: 'prod-avec',
        type: 'membership',
        variantKey: 'avec-alcool',
        amountCents: 3000,
        memberPriceTag: 'cotisant:cercle-sans-alcool',
        amountCentsMember: 1500,
        ...overrides,
      });

    /** A buyer of `target` among `tiers`, holding exactly the tags named. */
    function buyer(target: AssociationProduct, tiers: AssociationProduct[], held: string[]) {
      const made = makeService();
      made.assoRepo.findOne.mockResolvedValue(cercle());
      made.productRepo.findOne.mockResolvedValue(target);
      made.productRepo.find.mockResolvedValue(tiers);
      made.userTagService.hasActiveTag.mockImplementation((_u: string, tag: string) =>
        Promise.resolve(held.includes(tag))
      );
      return made;
    }

    /** The typed `code` of the 409 a promise rejects with. */
    const conflictCode = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ConflictException);
      return ((err as ConflictException).getResponse() as { code: string }).code;
    };

    it('quotes a holder of the linked tier the preferential price', async () => {
      const { service } = buyer(
        avecAlcool(),
        [sansAlcool(), avecAlcool()],
        ['cotisant:cercle-sans-alcool']
      );
      const result = await (service as any).resolvePurchase('asso1', 'prod-avec', 'user1');
      expect(result.amountCents).toBe(1500);
    });

    it('charges the full price of a rise whose tier has NO preferential price configured', async () => {
      // Nothing is computed from tier prices: without the admin's setting the rise costs in full.
      const { service } = buyer(
        avecAlcool({ memberPriceTag: null, amountCentsMember: null }),
        [sansAlcool(), avecAlcool()],
        ['cotisant:cercle-sans-alcool']
      );
      const result = await (service as any).resolvePurchase('asso1', 'prod-avec', 'user1');
      expect(result.amountCents).toBe(3000);
    });

    it('charges the full price to a buyer holding no tier', async () => {
      const { service } = buyer(avecAlcool(), [sansAlcool(), avecAlcool()], []);
      const result = await (service as any).resolvePurchase('asso1', 'prod-avec', 'user1');
      expect(result.amountCents).toBe(3000);
    });

    it('refuses a LOWER tier with TIER_NOT_A_RISE instead of silently downgrading', async () => {
      const { service, httpService } = buyer(
        sansAlcool(),
        [sansAlcool(), avecAlcool()],
        ['cotisant:cercle-avec-alcool']
      );
      expect(
        await conflictCode((service as any).resolvePurchase('asso1', 'prod-sans', 'user1'))
      ).toBe('TIER_NOT_A_RISE');
      expect((httpService.post as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('refuses a buyer holding TWO tiers at once with TIER_NOT_RANKABLE, before any request', async () => {
      // Ranked against one of the two and frozen on it, the settlement would read the other as
      // `held-changed` and refuse every time: the money would be taken for nothing.
      const top = product({
        id: 'prod-top',
        type: 'membership',
        variantKey: 'top',
        amountCents: 9000,
      });
      const { service, httpService } = buyer(
        top,
        [sansAlcool(), avecAlcool(), top],
        ['cotisant:cercle-sans-alcool', 'cotisant:cercle-avec-alcool']
      );
      expect(
        await conflictCode((service as any).resolvePurchase('asso1', 'prod-top', 'user1'))
      ).toBe('TIER_NOT_RANKABLE');
      expect((httpService.post as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('refuses an EQUALLY priced sibling tier with TIER_NOT_A_RISE', async () => {
      const other = product({
        id: 'prod-other',
        type: 'membership',
        variantKey: 'autre',
        amountCents: 1500,
      });
      const { service } = buyer(other, [sansAlcool(), other], ['cotisant:cercle-sans-alcool']);
      expect(
        await conflictCode((service as any).resolvePurchase('asso1', 'prod-other', 'user1'))
      ).toBe('TIER_NOT_A_RISE');
    });

    it('refuses the tier already held with PRODUCT_ALREADY_PURCHASED, even with no purchase record', async () => {
      // A manual grant holds the tier as surely as a purchase does.
      const { service, purchaseRecordService } = buyer(
        sansAlcool(),
        [sansAlcool(), avecAlcool()],
        ['cotisant:cercle-sans-alcool']
      );
      purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(0);
      expect(
        await conflictCode((service as any).resolvePurchase('asso1', 'prod-sans', 'user1'))
      ).toBe('PRODUCT_ALREADY_PURCHASED');
    });

    // A tier deleted while people still held it: its tag names no product, so no price. Read as
    // holding nothing, its holder could buy a cheaper tier and the XOR would never drop the tag.
    it('refuses any tier, TIER_NOT_RANKABLE, to a holder of a DELETED tier', async () => {
      for (const target of [sansAlcool(), avecAlcool()]) {
        const made = buyer(target, [sansAlcool(), avecAlcool()], []);
        made.userTagService.heldOrphanTierTags.mockResolvedValue([
          { tagName: 'cotisant:cercle-premium', variantKey: 'premium' },
        ]);
        expect(
          await conflictCode((made.service as any).resolvePurchase('asso1', target.id, 'user1'))
        ).toBe('TIER_NOT_RANKABLE');
      }
    });

    describe('deleting a tier people still hold', () => {
      /** A manager deleting `prod-sans` while `holders` people hold it. */
      function deleting(holders: number) {
        const made = makeService();
        made.assoRepo.findOne.mockResolvedValue(cercle());
        made.productRepo.findOne.mockResolvedValue(sansAlcool());
        made.manager.count = jest.fn(() => Promise.resolve(2));
        made.manager.remove = jest.fn(() => Promise.resolve());
        made.userTagService.countActiveTierHolders.mockResolvedValue(holders);
        return made;
      }

      it('is refused 409 TIER_HAS_HOLDERS with the count, under the EXCLUSIVE association lock', async () => {
        const { service, manager, userTagService } = deleting(3);
        const err = await service.delete('asso1', 'prod-sans').then(
          () => null,
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: 'TIER_HAS_HOLDERS',
          holderCount: 3,
        });
        // Scoped to THIS association: another one's count is never read, nor told.
        expect(userTagService.countActiveTierHolders).toHaveBeenCalledWith(
          'asso1',
          'cercle',
          'sans-alcool',
          manager
        );
        // The retag's lock, exclusive, and nothing removed.
        expect(manager.query).toHaveBeenCalledWith(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          ['tier:asso1']
        );
        expect(manager.remove).not.toHaveBeenCalled();
      });

      it('CONTROL: goes through when nobody holds it', async () => {
        const { service, manager } = deleting(0);
        await service.delete('asso1', 'prod-sans');
        expect(manager.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'prod-sans' }));
      });

      it('counts the holders with cotisations switched OFF too', async () => {
        const made = deleting(1);
        made.assoRepo.findOne.mockResolvedValue(
          asso({ id: 'asso1', slug: 'cercle', cotisationMode: null })
        );
        const err = await made.service.delete('asso1', 'prod-sans').then(
          () => null,
          (e: unknown) => e
        );
        expect(((err as ConflictException).getResponse() as { code: string }).code).toBe(
          'TIER_HAS_HOLDERS'
        );
        expect(made.manager.remove).not.toHaveBeenCalled();
      });

      it('is refused 409 TIER_CHECKOUT_OPEN while a payment of the tier may still land', async () => {
        const { service, manager } = deleting(0);
        manager.query.mockImplementation((sql: string) =>
          Promise.resolve(sql.includes('FROM product_checkouts') ? [{ n: 1 }] : [])
        );
        const err = await service.delete('asso1', 'prod-sans').then(
          () => null,
          (e: unknown) => e
        );
        expect(((err as ConflictException).getResponse() as { code: string }).code).toBe(
          'TIER_CHECKOUT_OPEN'
        );
        expect(manager.remove).not.toHaveBeenCalled();
      });
    });

    it('sells a gridded tier at its cell to a buyer holding no tier', async () => {
      const gridded = product({
        id: 'prod-grid',
        type: 'membership',
        variantKey: 'grille',
        amountCents: null,
        priceMatrix: { dimensions: [], cells: [] } as any,
      });
      const made = buyer(gridded, [avecAlcool(), gridded], []);
      jest.spyOn(made.service as any, 'resolveGridPrice').mockReturnValue(700);
      const result = await (made.service as any).resolvePurchase('asso1', 'prod-grid', 'user1');
      expect(result.amountCents).toBe(700);
    });

    describe('a tier that cannot be ranked by a fixed price is refused TIER_NOT_RANKABLE', () => {
      const gridded = () =>
        product({
          id: 'prod-grid',
          type: 'membership',
          variantKey: 'grille',
          amountCents: null,
          priceMatrix: { dimensions: [], cells: [] } as any,
        });
      const free = () =>
        product({
          id: 'prod-free',
          type: 'membership',
          variantKey: 'libre',
          amountCents: null,
          allowCustomAmount: true,
        });

      it('while the HELD tier is gridded', async () => {
        const { service } = buyer(
          avecAlcool(),
          [avecAlcool(), gridded()],
          ['cotisant:cercle-grille']
        );
        expect(
          await conflictCode((service as any).resolvePurchase('asso1', 'prod-avec', 'user1'))
        ).toBe('TIER_NOT_RANKABLE');
      });

      it('while the HELD tier is a free amount', async () => {
        const { service } = buyer(sansAlcool(), [sansAlcool(), free()], ['cotisant:cercle-libre']);
        expect(
          await conflictCode((service as any).resolvePurchase('asso1', 'prod-sans', 'user1'))
        ).toBe('TIER_NOT_RANKABLE');
      });

      it('when the TARGET is gridded and a fixed tier is held', async () => {
        const { service } = buyer(
          gridded(),
          [sansAlcool(), gridded()],
          ['cotisant:cercle-sans-alcool']
        );
        expect(
          await conflictCode((service as any).resolvePurchase('asso1', 'prod-grid', 'user1'))
        ).toBe('TIER_NOT_RANKABLE');
      });
    });

    describe('precedence between the tier codes and the purchase records', () => {
      it('the held tier answers PRODUCT_ALREADY_PURCHASED whether or not it was bought', async () => {
        for (const paid of [0, 1]) {
          const made = buyer(
            sansAlcool({ grantedTagName: 'cotisant:cercle-sans-alcool' }),
            [sansAlcool(), avecAlcool()],
            ['cotisant:cercle-sans-alcool']
          );
          made.purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(paid);
          expect(
            await conflictCode((made.service as any).resolvePurchase('asso1', 'prod-sans', 'user1'))
          ).toBe('PRODUCT_ALREADY_PURCHASED');
        }
      });

      it('a tier bought before a rise answers TIER_NOT_A_RISE, not a renewal', async () => {
        // Bought cheap, then rose: the cheap tag is gone, so the records alone read "may renew".
        const made = buyer(
          sansAlcool({ grantedTagName: 'cotisant:cercle-sans-alcool' }),
          [sansAlcool(), avecAlcool()],
          ['cotisant:cercle-avec-alcool']
        );
        made.purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(1);
        expect(
          await conflictCode((made.service as any).resolvePurchase('asso1', 'prod-sans', 'user1'))
        ).toBe('TIER_NOT_A_RISE');
      });
    });

    it('a holder of TWO tier tags is answered PRODUCT_ALREADY_PURCHASED for either, whatever order the tiers load in', async () => {
      for (const tiers of [
        [sansAlcool(), avecAlcool()],
        [avecAlcool(), sansAlcool()],
      ]) {
        const both = ['cotisant:cercle-sans-alcool', 'cotisant:cercle-avec-alcool'];
        // The cheaper of the two is HELD, not "not a rise": the answer names what is true.
        const cheap = buyer(sansAlcool(), tiers, both);
        expect(
          await conflictCode((cheap.service as any).resolvePurchase('asso1', 'prod-sans', 'user1'))
        ).toBe('PRODUCT_ALREADY_PURCHASED');
        const dear = buyer(avecAlcool(), tiers, both);
        expect(
          await conflictCode((dear.service as any).resolvePurchase('asso1', 'prod-avec', 'user1'))
        ).toBe('PRODUCT_ALREADY_PURCHASED');
      }
    });

    describe('a dated association keeps the preferential price across the academic-year rollover', () => {
      afterEach(() => jest.useRealTimers());

      it('reads a link saved in 2026-2027 as the tier, in 2027-2028', async () => {
        jest.useFakeTimers({ now: new Date('2027-10-01T12:00:00Z'), doNotFake: ['nextTick'] });
        const made = buyer(
          avecAlcool({ memberPriceTag: 'cotisant:cercle-sans-alcool-2026-2027' }),
          [sansAlcool(), avecAlcool()],
          // Only this year's tag is active: last year's has expired.
          ['cotisant:cercle-sans-alcool-2027-2028']
        );
        made.assoRepo.findOne.mockResolvedValue(
          asso({ id: 'asso1', slug: 'cercle', cotisationMode: 'dated' })
        );
        const result = await (made.service as any).resolvePurchase('asso1', 'prod-avec', 'user1');
        expect(result.amountCents).toBe(1500);
      });

      it('charges in full a buyer who held the linked tier only LAST year', async () => {
        jest.useFakeTimers({ now: new Date('2027-10-01T12:00:00Z'), doNotFake: ['nextTick'] });
        const made = buyer(
          avecAlcool({ memberPriceTag: 'cotisant:cercle-sans-alcool-2026-2027' }),
          [sansAlcool(), avecAlcool()],
          []
        );
        made.assoRepo.findOne.mockResolvedValue(
          asso({ id: 'asso1', slug: 'cercle', cotisationMode: 'dated' })
        );
        const result = await (made.service as any).resolvePurchase('asso1', 'prod-avec', 'user1');
        expect(result.amountCents).toBe(3000);
      });
    });

    describe('member pricing nothing could honour is refused at save', () => {
      function editing(target: AssociationProduct) {
        const made = makeService();
        made.assoRepo.findOne.mockResolvedValue(cercle());
        made.productRepo.findOne.mockResolvedValue(target);
        made.productRepo.find.mockResolvedValue([sansAlcool(), target]);
        return made;
      }

      it('refuses a preferential price at or above the full price, or not above zero', async () => {
        for (const amountCentsMember of [3000, 3500, 0]) {
          const { service } = editing(avecAlcool());
          await expect(
            service.update('asso1', 'prod-avec', { amountCentsMember }, false)
          ).rejects.toThrow(BadRequestException);
        }
      });

      it('refuses a link that names no other tier of the association', async () => {
        for (const memberPriceTag of [
          'cotisant:bde',
          'cotisant:cercle-vip',
          'cotisant:cercle-avec-alcool',
        ]) {
          const { service } = editing(avecAlcool());
          const err = await service.update('asso1', 'prod-avec', { memberPriceTag }, false).then(
            () => null,
            (e: unknown) => e
          );
          expect(err).toBeInstanceOf(BadRequestException);
          expect((err as BadRequestException).getResponse()).toMatchObject({
            code: 'MEMBER_PRICE_TAG_NOT_A_TIER',
          });
        }
      });

      it('refuses the same link on creation, typed, before anything is saved', async () => {
        const { service, productRepo } = editing(avecAlcool());
        const err = await service
          .create(
            'asso1',
            {
              name: 'Soiree',
              type: 'other',
              amountCents: 2000,
              amountCentsMember: 1000,
              memberPriceTag: 'cotisant:bde',
            },
            false
          )
          .then(
            () => null,
            (e: unknown) => e
          );
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'MEMBER_PRICE_TAG_NOT_A_TIER',
        });
        expect(productRepo.save).not.toHaveBeenCalled();
      });

      it('accepts a link to a sibling tier, in either tag form', async () => {
        for (const memberPriceTag of [
          'cotisant:cercle-sans-alcool',
          'cotisant:cercle-sans-alcool-2026-2027',
        ]) {
          const { service } = editing(avecAlcool());
          await expect(
            service.update('asso1', 'prod-avec', { memberPriceTag }, false)
          ).resolves.toMatchObject({ memberPriceTag });
        }
      });

      it('saves an unrelated edit of a row written before the rule', async () => {
        const { service } = editing(avecAlcool({ memberPriceTag: 'cotisant:elsewhere' }));
        await expect(
          service.update('asso1', 'prod-avec', { name: 'Avec alcool' }, false)
        ).resolves.toMatchObject({ name: 'Avec alcool' });
      });

      it('re-points the siblings linked to a tier when that tier changes key', async () => {
        const { service, productRepo, assoRepo, manager } = makeService();
        assoRepo.findOne.mockResolvedValue(cercle());
        productRepo.findOne.mockResolvedValue(sansAlcool());
        productRepo.find.mockResolvedValue([sansAlcool(), avecAlcool()]);
        manager.save = jest.fn((_e: unknown, x: unknown) => Promise.resolve(x));
        manager.update = jest.fn(() => Promise.resolve({ affected: 1 }));
        manager.createQueryBuilder = jest.fn(() => {
          const qb: any = {};
          for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
          qb.execute = jest.fn(() => Promise.resolve({ affected: 0 }));
          return qb;
        });

        await service.update('asso1', 'prod-sans', { variantKey: 'soft' }, false);
        expect(manager.update).toHaveBeenCalledWith(
          AssociationProduct,
          { id: expect.anything() },
          { memberPriceTag: 'cotisant:cercle-soft' }
        );
      });

      /** A retag of `current` among the Cercle's two tiers, its writes answered. */
      function retagging(current: AssociationProduct) {
        const made = makeService();
        made.assoRepo.findOne.mockResolvedValue(cercle());
        made.productRepo.findOne.mockResolvedValue(current);
        made.productRepo.find.mockResolvedValue([current, avecAlcool()]);
        made.manager.save = jest.fn((_e: unknown, x: unknown) => Promise.resolve(x));
        made.manager.update = jest.fn(() => Promise.resolve({ affected: 1 }));
        made.manager.createQueryBuilder = jest.fn(() => {
          const qb: any = {};
          for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
          qb.execute = jest.fn(() => Promise.resolve({ affected: 0 }));
          return qb;
        });
        return made;
      }

      // `cotisant:cercle-2026-2027` is the base tier's dated tag: the retag is refused, typed, and
      // nothing is written.
      it('refuses a retag TO a key shaped like an academic year, typed TIER_KEY_YEAR_SHAPED', async () => {
        for (const variantKey of ['2026-2027', 'soft-2026-2027']) {
          const { service, manager } = retagging(sansAlcool());
          const err = await service.update('asso1', 'prod-sans', { variantKey }, false).then(
            () => null,
            (e: unknown) => e
          );
          expect(err).toBeInstanceOf(BadRequestException);
          expect((err as BadRequestException).getResponse()).toMatchObject({
            code: 'TIER_KEY_YEAR_SHAPED',
          });
          expect(manager.save).not.toHaveBeenCalled();
        }
      });

      // A tier keyed like a year before the rule is not stuck with it: renaming it away is the fix.
      it('accepts a retag FROM a year-shaped key to a plain key, and to the base tier', async () => {
        for (const variantKey of ['soft', null]) {
          const { service, manager } = retagging(sansAlcool({ variantKey: '2024-2025' }));
          await expect(
            service.update('asso1', 'prod-sans', { variantKey }, false)
          ).resolves.toMatchObject({ variantKey });
          expect(manager.save).toHaveBeenCalled();
        }
      });
    });

    it('annotates the per-association listing too, guest included', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const tiers = [sansAlcool(), avecAlcool()];
      productRepo.find.mockResolvedValue(tiers);
      assoRepo.find.mockResolvedValue([cercle()]);
      userTagService.listByUser.mockResolvedValue([
        { tagName: 'cotisant:cercle-sans-alcool', issuingAssocId: 'asso1' },
      ]);

      const mine = await service.listByAssoc('asso1', 'user1');
      expect(mine.find((p) => p.id === 'prod-avec')).toMatchObject({
        viewerTierRelation: 'higher',
        viewerDueCents: 1500,
      });
      const guest = await service.listByAssoc('asso1');
      expect(guest.find((p) => p.id === 'prod-avec')).toMatchObject({
        viewerTierRelation: 'none',
        viewerDueCents: 3000,
      });
    });

    it('keeps the sibling XOR on the rise it allows', async () => {
      // The sale re-reads the product after the tier locks: the stored row is what it grants.
      const { service, userTagService, manager } = buyer(
        avecAlcool({ grantedTagName: 'cotisant:cercle-avec-alcool' }),
        [sansAlcool(), avecAlcool()],
        ['cotisant:cercle-sans-alcool']
      );
      await (service as any).fulfillProductPurchase({
        product: avecAlcool({ grantedTagName: 'cotisant:cercle-avec-alcool' }),
        userId: 'user1',
        amountCents: 1500,
        paymentMethod: 'cash',
        stripePaymentIntentId: null,
        grantedBy: 'admin1',
        dispatchWebhook: false,
      });
      expect(userTagService.revokeSiblingTierTags).toHaveBeenCalledWith(
        'asso1',
        'user1',
        'avec-alcool',
        manager
      );
    });

    describe('the shop listing says where each tier stands, and what it would charge', () => {
      async function listed(
        heldTags: string[],
        extra: AssociationProduct[] = [],
        issuingAssocId = 'asso1'
      ) {
        const { service, productRepo, assoRepo, userTagService } = makeService();
        const all = [sansAlcool(), avecAlcool(), ...extra];
        const tiers = all.filter((p) => p.type === 'membership');
        productRepo.find.mockResolvedValueOnce(all).mockResolvedValueOnce(tiers);
        assoRepo.find.mockResolvedValue([cercle()]);
        userTagService.listByUser.mockResolvedValue(
          heldTags.map((tagName) => ({ tagName, issuingAssocId }))
        );
        const result = await service.listAllActive('user1');
        return (id: string) => {
          const p = result.find((r) => r.id === id)!;
          return { relation: p.viewerTierRelation, due: p.viewerDueCents };
        };
      }

      it('a holder of the cheaper tier: held / higher at the preferential price', async () => {
        const of = await listed(['cotisant:cercle-sans-alcool']);
        expect(of('prod-sans')).toEqual({ relation: 'held', due: null });
        expect(of('prod-avec')).toEqual({ relation: 'higher', due: 1500 });
      });

      it('a holder of the dearer tier: lower (not buyable) / held', async () => {
        const of = await listed(['cotisant:cercle-avec-alcool']);
        expect(of('prod-sans')).toEqual({ relation: 'lower', due: null });
        expect(of('prod-avec')).toEqual({ relation: 'held', due: null });
      });

      it('a tag of the same name issued by ANOTHER association holds no tier here', async () => {
        const of = await listed(['cotisant:cercle-avec-alcool'], [], 'asso2');
        expect(of('prod-sans')).toEqual({ relation: 'none', due: 1500 });
        expect(of('prod-avec')).toEqual({ relation: 'none', due: 3000 });
      });

      it('a viewer holding nothing: none, each at its full price', async () => {
        const of = await listed([]);
        expect(of('prod-sans')).toEqual({ relation: 'none', due: 1500 });
        expect(of('prod-avec')).toEqual({ relation: 'none', due: 3000 });
      });

      it('a non-tier product is none, and quoted like any product (cotisant price included)', async () => {
        const goodies = product({
          id: 'prod-goodies',
          type: 'other',
          amountCents: 500,
          amountCentsMember: 300,
        });
        const of = await listed(['cotisant:cercle-avec-alcool'], [goodies]);
        expect(of('prod-goodies')).toEqual({ relation: 'none', due: 300 });
      });

      // The checkout refuses a holder of TWO tiers any other tier (`TIER_NOT_RANKABLE`): the
      // listing reads the same `relationOf`, so it offers nothing the checkout would refuse.
      it('a holder of TWO tiers: unranked (not buyable) for a third, held for both held', async () => {
        const premium = product({
          id: 'prod-premium',
          type: 'membership',
          variantKey: 'premium',
          amountCents: 5000,
        });
        const of = await listed(
          ['cotisant:cercle-sans-alcool', 'cotisant:cercle-avec-alcool'],
          [premium]
        );
        expect(of('prod-premium')).toEqual({ relation: 'unranked', due: null });
        expect(of('prod-sans')).toEqual({ relation: 'held', due: null });
        expect(of('prod-avec')).toEqual({ relation: 'held', due: null });
      });

      it('CONTROL: a holder of ONE tier is offered the dearer third tier', async () => {
        const premium = product({
          id: 'prod-premium',
          type: 'membership',
          variantKey: 'premium',
          amountCents: 5000,
        });
        const of = await listed(['cotisant:cercle-sans-alcool'], [premium]);
        expect(of('prod-premium')).toEqual({ relation: 'higher', due: 5000 });
      });
    });

    describe('the listing names what the checkout refuses or prices', () => {
      it('a membership of an association whose cotisations are disabled: not offered, no price', async () => {
        const { service, productRepo, assoRepo, userTagService } = makeService();
        const goodies = product({ id: 'prod-goodies', type: 'other', amountCents: 500 });
        productRepo.find.mockResolvedValue([sansAlcool(), goodies]);
        assoRepo.find.mockResolvedValue([
          asso({ id: 'asso1', slug: 'cercle', cotisationMode: null }),
        ]);
        userTagService.listByUser.mockResolvedValue([]);

        for (const listing of [
          await service.listByAssoc('asso1', 'user1'),
          await service.listByAssoc('asso1'),
        ]) {
          expect(listing.find((p) => p.id === 'prod-sans')).toMatchObject({
            cotisationDisabled: true,
            viewerDueCents: null,
          });
          expect(listing.find((p) => p.id === 'prod-goodies')).toMatchObject({
            cotisationDisabled: false,
            viewerDueCents: 500,
          });
        }
      });

      it('CONTROL: an association with a cotisation mode sells its memberships', async () => {
        const { service, productRepo, assoRepo } = makeService();
        productRepo.find.mockResolvedValue([sansAlcool()]);
        assoRepo.find.mockResolvedValue([cercle()]);

        const [sans] = await service.listByAssoc('asso1');
        expect(sans).toMatchObject({ cotisationDisabled: false, viewerDueCents: 1500 });
      });

      // The tier facts and the cotisation-disabled mark both need the associations: one read.
      it('reads the associations ONCE for a signed-in listing, and not at all for a guest with no membership', async () => {
        const { service, productRepo, assoRepo, userTagService } = makeService();
        productRepo.find.mockResolvedValue([sansAlcool(), avecAlcool()]);
        assoRepo.find.mockResolvedValue([cercle()]);
        userTagService.listByUser.mockResolvedValue([
          { tagName: 'cotisant:cercle-sans-alcool', issuingAssocId: 'asso1' },
        ]);

        const listing = await service.listByAssoc('asso1', 'user1');
        expect(assoRepo.find).toHaveBeenCalledTimes(1);
        expect(listing.find((p) => p.id === 'prod-avec')).toMatchObject({
          viewerTierRelation: 'higher',
          cotisationDisabled: false,
        });

        assoRepo.find.mockClear();
        productRepo.find.mockResolvedValue([
          product({ id: 'prod-goodies', type: 'other', amountCents: 500 }),
        ]);
        await service.listByAssoc('asso1');
        expect(assoRepo.find).not.toHaveBeenCalled();
      });

      it('names the tier a preferential price is linked to, whichever tier the viewer holds first', async () => {
        const { service, productRepo, assoRepo, userTagService } = makeService();
        productRepo.find.mockResolvedValue([sansAlcool(), avecAlcool()]);
        assoRepo.find.mockResolvedValue([cercle()]);
        userTagService.listByUser.mockResolvedValue([
          { tagName: 'cotisant:cercle-sans-alcool', issuingAssocId: 'asso1' },
        ]);

        const listing = await service.listByAssoc('asso1', 'user1');
        expect(listing.find((p) => p.id === 'prod-avec')?.memberPriceTierKey).toBe('sans-alcool');
        expect(listing.find((p) => p.id === 'prod-sans')).not.toHaveProperty('memberPriceTierKey');
      });

      it('warns ONCE per product about a member-price tag naming no tier, however many quotes read it', async () => {
        const { service, productRepo, assoRepo, userTagService } = makeService();
        const warn = jest.spyOn((service as any).logger, 'warn');
        productRepo.find.mockResolvedValue([
          sansAlcool(),
          avecAlcool({ memberPriceTag: 'cotisant:elsewhere' }),
        ]);
        assoRepo.find.mockResolvedValue([cercle()]);
        userTagService.listByUser.mockResolvedValue([
          { tagName: 'cotisant:cercle-sans-alcool', issuingAssocId: 'asso1' },
        ]);

        await service.listByAssoc('asso1', 'user1');
        const second = await service.listByAssoc('asso1', 'user1');
        expect(second.find((p) => p.id === 'prod-avec')).toMatchObject({ viewerDueCents: 3000 });
        expect(
          warn.mock.calls.filter(([line]) => String(line).includes('memberPriceTag names no'))
        ).toHaveLength(1);
      });
    });
  });

  describe('getCotisantStatusBySlug (WP-COT-4, inbound Cercle check)', () => {
    it('throws NotFoundException for an unknown slug', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(null);

      await expect(service.getCotisantStatusBySlug('missing', 'user1')).rejects.toThrow(
        'Association not found'
      );
    });

    it('returns isCotisant=false when the association has no cotisation mode', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: null }));

      const status = await service.getCotisantStatusBySlug('bde', 'user1');
      expect(status).toEqual({ isCotisant: false, tier: null, expiresAt: null });
    });

    it('returns isCotisant=false when the user holds no active tier tag', async () => {
      const { service, assoRepo, productRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'bde', cotisationMode: 'lifetime' }));
      productRepo.find.mockResolvedValue([]);
      userTagService.getActiveTag.mockResolvedValue(null);

      const status = await service.getCotisantStatusBySlug('bde', 'user1');
      expect(status).toEqual({ isCotisant: false, tier: null, expiresAt: null });
    });

    // An association with no Stripe account has every tier product inactive, so filtering the
    // lookup on `isActive` reported each of its cotisants as `isCotisant: false` - which locks
    // the whole Cercle out rather than degrading it.
    it('enumerates tiers that are not on sale, so their cotisants stay recognized', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      productRepo.find.mockResolvedValue([]);

      await service.getCotisantStatusBySlug('cercle', 'user1');
      expect(productRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { associationId: 'asso1', type: 'membership' },
        })
      );
    });

    it('returns the held tier and its expiry for a multi-tier association', async () => {
      const { service, assoRepo, productRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      productRepo.find.mockResolvedValue([
        { variantKey: 'avec-alcool' },
        { variantKey: 'sans-alcool' },
      ]);
      const expiresAt = new Date('2999-01-01T00:00:00Z');
      userTagService.getActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === 'cotisant:cercle-sans-alcool' ? { expiresAt } : null)
      );

      const status = await service.getCotisantStatusBySlug('cercle', 'user1');
      expect(status).toEqual({
        isCotisant: true,
        tier: 'sans-alcool',
        expiresAt: expiresAt.toISOString(),
      });
    });

    it('returns a null expiresAt for a lifetime single-tier tag', async () => {
      const { service, assoRepo, productRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: 'bde', cotisationMode: 'lifetime' }));
      productRepo.find.mockResolvedValue([]);
      userTagService.getActiveTag.mockResolvedValue({ expiresAt: null });

      const status = await service.getCotisantStatusBySlug('bde', 'user1');
      expect(status).toEqual({ isCotisant: true, tier: null, expiresAt: null });
    });
  });

  describe('setProductIcon / clearProductIcon', () => {
    const file = { buffer: Buffer.from('x'), mimetype: 'image/png', size: 1024 };

    it('uploads the icon, sets iconMediaId/iconUrl, and deletes the previous media object', async () => {
      const { service, productRepo, associationsService } = makeService();
      productRepo.findOne.mockResolvedValue(product({ iconMediaId: 'old-media' }));
      associationsService.uploadPublicImage.mockResolvedValue('new-media');

      const result = await service.setProductIcon('asso1', 'prod1', file, 'Bearer token');

      expect(associationsService.uploadPublicImage).toHaveBeenCalledWith(file, 'Bearer token');
      expect(result.iconMediaId).toBe('new-media');
      expect(result.iconUrl).toContain('/api/media/public/new-media');
      expect(associationsService.deleteMediaBestEffort).toHaveBeenCalledWith(
        'old-media',
        'Bearer token'
      );
    });

    it('rejects a file over the size limit', async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product());

      await expect(
        service.setProductIcon('asso1', 'prod1', { ...file, size: 3 * 1024 * 1024 }, 'Bearer token')
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a disallowed mime type', async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product());

      await expect(
        service.setProductIcon('asso1', 'prod1', { ...file, mimetype: 'image/gif' }, 'Bearer token')
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a missing bearer token', async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product());

      await expect(service.setProductIcon('asso1', 'prod1', file, undefined)).rejects.toThrow(
        BadRequestException
      );
    });

    it('clears the icon and best-effort deletes the old media object', async () => {
      const { service, productRepo, associationsService } = makeService();
      productRepo.findOne.mockResolvedValue(product({ iconMediaId: 'old-media' }));

      const result = await service.clearProductIcon('asso1', 'prod1', 'Bearer token');

      expect(result.iconMediaId).toBeNull();
      expect(result.iconUrl).toBeNull();
      expect(associationsService.deleteMediaBestEffort).toHaveBeenCalledWith(
        'old-media',
        'Bearer token'
      );
    });
  });

  describe('pricing grid on a product (promo/formation/cotisation)', () => {
    /** Two promos and the generated "everyone else" bucket - the smallest grid worth pricing on. */
    const promoGrid = (cells: Record<string, number | null>) => ({
      dimensions: [
        {
          id: 'd1',
          kind: 'promo' as const,
          buckets: [
            { id: 'b1', label: '1A', values: [2025] },
            { id: 'b2', label: '2A', values: [2024] },
          ],
        },
      ],
      cells,
    });

    it('prices a purchase from the grid and ignores the member-price columns entirely', async () => {
      const { service, productRepo, assoRepo, userTagService, pricingFacts } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        // Both fixed levers are set and BOTH must be ignored: a grid replaces them, it never
        // layers on them, or an order between the two would decide money.
        product({
          amountCents: 1000,
          amountCentsMember: 500,
          priceMatrix: promoGrid({ b1: 7000, b2: 9000, _others: 12000 }),
        })
      );
      userTagService.hasActiveTag.mockResolvedValue(true);
      // The profile is fetched before the tier lock, the cotisation half under it.
      pricingFacts.profileFor.mockResolvedValue({ promo: 2024, formation: 'ICM' });

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(9000);
    });

    // The profile is fetched before the lock, from the product read then; a grid that came to need
    // it by the time the product is re-read under the lock cannot be priced without a call there.
    it('refuses PURCHASE_PRICING_CHANGED when the grid needs a profile the preparation did not fetch', async () => {
      const { service, productRepo, assoRepo, pricingFacts } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne
        .mockResolvedValueOnce(product({ amountCents: 1000 }))
        .mockResolvedValue(product({ priceMatrix: promoGrid({ b1: 7000, b2: 9000, _others: 1 }) }));

      const err = await (service as any).resolvePurchase('asso1', 'prod1', 'user1').then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(((err as ConflictException).getResponse() as { code: string }).code).toBe(
        'PURCHASE_PRICING_CHANGED'
      );
      expect(pricingFacts.profileFor).toHaveBeenCalledWith('user1', false);
    });

    it('CONTROL: a grid that needed the profile from the start is priced from it', async () => {
      const { service, productRepo, assoRepo, pricingFacts } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        product({ priceMatrix: promoGrid({ b1: 7000, b2: 9000, _others: 12000 }) })
      );
      pricingFacts.profileFor.mockResolvedValue({ promo: 2025, formation: null });

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(7000);
    });

    describe('a cash sale of a gridded product, quoted and recorded', () => {
      const gridSetUp = (cells: Record<string, number | null>) => {
        const made = makeService();
        made.assoRepo.findOne.mockResolvedValue(asso());
        made.productRepo.findOne.mockResolvedValue(
          product({ amountCents: 1000, amountCentsMember: 500, priceMatrix: promoGrid(cells) })
        );
        made.pricingFacts.profileFor.mockResolvedValue({ promo: 2024, formation: null });
        made.productRepo.manager.query.mockResolvedValue([{ id: 'user1' }]);
        made.purchaseRecordService.create.mockImplementation((x: unknown) =>
          Promise.resolve({
            ...(x as object),
            id: 'rec1',
            paidAt: new Date('2026-10-29T12:00:00Z'),
          })
        );
        return made;
      };

      it("quotes and records the beneficiary's cell, never the fixed or member price", async () => {
        const { service, purchaseRecordService } = gridSetUp({ b1: 7000, b2: 9000, _others: 1 });
        await expect(service.quoteCashSale('asso1', 'prod1', 'user1')).resolves.toEqual({
          kind: 'priced',
          amountCents: 9000,
          preferential: false,
        });
        await service.grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1' });
        expect(purchaseRecordService.create).toHaveBeenCalledWith(
          expect.objectContaining({ amountCents: 9000 }),
          expect.anything()
        );
      });

      it('quotes `not-sold` where the grid closes the combination, and the sale refuses with nothing typed', async () => {
        const { service, purchaseRecordService } = gridSetUp({ b1: 7000, b2: null, _others: 1 });
        await expect(service.quoteCashSale('asso1', 'prod1', 'user1')).resolves.toEqual({
          kind: 'not-sold',
        });
        await expect(
          service.grantProductPurchase('asso1', 'prod1', 'admin1', { userId: 'user1' })
        ).rejects.toThrow(BadRequestException);
        expect(purchaseRecordService.create).not.toHaveBeenCalled();
      });
    });

    it('prices an unrecognised promo from the generated "everyone else" cell', async () => {
      const { service, productRepo, assoRepo, pricingFacts } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        product({ priceMatrix: promoGrid({ b1: 7000, b2: 9000, _others: 12000 }) })
      );
      // A promo nobody named, and a null promo, are the same answer: nobody is ever unpriced.
      pricingFacts.build.mockResolvedValue({
        promo: null,
        formation: null,
        cotisationTiers: [],
        answers: {},
      });

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(12000);
    });

    it('REFUSES the purchase when the grid marks the combination as not sold', async () => {
      const { service, productRepo, assoRepo, pricingFacts } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        // `null` is a decision, not a price of zero and not a missing cell: the association does
        // not sell this forfait to that cohort, so the sale stops rather than falling back.
        product({
          amountCents: 1000,
          priceMatrix: promoGrid({ b1: 7000, b2: null, _others: 12000 }),
        })
      );
      pricingFacts.profileFor.mockResolvedValue({ promo: 2024, formation: null });

      await expect((service as any).resolvePurchase('asso1', 'prod1', 'user1')).rejects.toThrow(
        BadRequestException
      );
    });

    it('does not ask core-service for a profile when no dimension needs one', async () => {
      const { service, productRepo, assoRepo, pricingFacts, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: 'lifetime' }));
      // The buyer holds the base tier: the grid's cotisation half is read under the tier lock.
      productRepo.find.mockResolvedValue([product({ type: 'membership', variantKey: null })]);
      userTagService.hasActiveTag.mockResolvedValue(true);
      productRepo.findOne.mockResolvedValue(
        product({
          priceMatrix: {
            dimensions: [
              {
                id: 'd1',
                kind: 'cotisation' as const,
                buckets: [{ id: 'b1', label: 'Cotisant', anyTier: true }],
              },
            ],
            cells: { b1: 500, _others: 1000 },
          },
        })
      );

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(500);
      // The point of the flag: a grid resting only on cotisation must not be blocked by, or wait
      // on, a service it does not need.
      expect(pricingFacts.build).not.toHaveBeenCalled();
      expect(pricingFacts.profileFor).toHaveBeenCalledWith('user1', false);
    });

    it('refuses a grid that prices on a question, which only a form has', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.find.mockResolvedValue([{ variantKey: null }]);

      await expect(
        service.create(
          'asso1',
          {
            name: 'Cotisation',
            type: 'other',
            amountCents: 1000,
            priceMatrix: {
              dimensions: [
                {
                  id: 'd1',
                  kind: 'answer',
                  questionId: 'q1',
                  buckets: [{ id: 'b1', label: 'Menu', values: ['o1'] }],
                },
              ],
              cells: { b1: 100, _others: 200 },
            },
          } as any,
          false
        )
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses an incomplete grid at save time rather than at purchase time', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.find.mockResolvedValue([{ variantKey: null }]);

      await expect(
        service.create(
          'asso1',
          {
            name: 'Cotisation',
            type: 'other',
            amountCents: 1000,
            // `_others` is missing, so somebody would arrive with no price at all.
            priceMatrix: promoGrid({ b1: 7000, b2: 9000 }),
          } as any,
          false
        )
      ).rejects.toThrow(BadRequestException);
    });

    it('stores the PARSED grid, never the raw document a client sent', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(product({ id: 'prod1' }));
      productRepo.find.mockResolvedValue([{ variantKey: null }]);

      await service.update(
        'asso1',
        'prod1',
        {
          // A field the parser does not keep: what lands in the column must be the normalised
          // document, or a grid nothing validated is what gets evaluated later.
          priceMatrix: { ...promoGrid({ b1: 1, b2: 2, _others: 3 }), junk: 'nope' },
        } as any,
        false
      );
      const saved = productRepo.save.mock.calls[0][0] as any;
      expect(saved.priceMatrix).toEqual(promoGrid({ b1: 1, b2: 2, _others: 3 }));
      expect(saved.priceMatrix.junk).toBeUndefined();
    });
  });

  describe('a product withheld for want of a payment account is released, once there is one', () => {
    const notReady = () =>
      asso({ lydiaOnboardingComplete: false, lydiaAccountId: null, cotisationMode: null });

    it('marks a product WITHHELD when the caller wanted it on sale but payments are not ready', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(notReady());

      const created = await service.create(
        'asso1',
        { name: 'Sweat', type: 'other', amountCents: 2500 } as any,
        false
      );
      expect(created.isActive).toBe(false);
      expect(created.activationWithheld).toBe(true);
    });

    it('does NOT mark a product withheld when the caller asked for it off sale', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(notReady());

      // Nothing was withheld here: the admin decided. Releasing it later would put on sale a
      // product nobody ever asked to sell - which is why the flag records the ASK, not the state.
      const created = await service.create(
        'asso1',
        { name: 'Sweat', type: 'other', amountCents: 2500, isActive: false } as any,
        false
      );
      expect(created.isActive).toBe(false);
      expect(created.activationWithheld).toBe(false);
    });

    it('creates an active, unwithheld product when payments are ready', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());

      const created = await service.create(
        'asso1',
        { name: 'Sweat', type: 'other', amountCents: 2500 } as any,
        false
      );
      expect(created.isActive).toBe(true);
      expect(created.activationWithheld).toBe(false);
    });

    it('releases only the WITHHELD products, never one an admin took off sale', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.update.mockResolvedValue({ affected: 2 });

      expect(await service.releaseWithheldProducts('asso1')).toBe(2);
      // The allowlist IS the where clause: `isActive: false` would sweep up deliberate withdrawals.
      expect(productRepo.update).toHaveBeenCalledWith(
        { associationId: 'asso1', activationWithheld: true },
        { isActive: true, activationWithheld: false }
      );
    });

    it('releases nothing while the payment target is still not ready', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(notReady());

      expect(await service.releaseWithheldProducts('asso1')).toBe(0);
      expect(productRepo.update).not.toHaveBeenCalled();
    });

    it("releases a delegating club's products when its PARENT completes onboarding", async () => {
      const { service, assoRepo, productRepo } = makeService();
      const parent = asso({ id: 'parent1' });
      const club = asso({
        id: 'club1',
        lydiaOnboardingComplete: false,
        lydiaAccountId: null,
        paymentParentAssociationId: 'parent1',
        paymentDelegationStatus: 'approved',
      });
      assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(id === 'parent1' ? parent : club)
      );
      // The delegating children of parent1 - the association whose row just changed is not the
      // only one whose payments just became possible.
      assoRepo.find.mockResolvedValue([{ id: 'club1' }]);
      productRepo.update.mockResolvedValue({ affected: 1 });

      expect(await service.releaseWithheldForAssociationAndDelegates('parent1')).toBe(2);
      expect(productRepo.update).toHaveBeenCalledWith(
        { associationId: 'club1', activationWithheld: true },
        { isActive: true, activationWithheld: false }
      );
    });

    describe('provider activation sweep (payments switched on platform-wide)', () => {
      it('releases the withheld products of every association that is now ready', async () => {
        const { service, assoRepo, productRepo } = makeService();
        productRepo.__setWithheld(['a1', 'a2']);
        assoRepo.find.mockResolvedValue([asso({ id: 'a1' }), asso({ id: 'a2' })] as any);
        // The release re-reads each association under its share lock.
        assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
          Promise.resolve(asso({ id }))
        );
        productRepo.update.mockResolvedValue({ affected: 1 });

        expect(await service.releaseWithheldForAllAssociations()).toEqual({
          released: 2,
          failed: 0,
        });
        // Allowlist again: only `activationWithheld: true` rows are ever touched.
        expect(productRepo.update).toHaveBeenCalledWith(
          { associationId: 'a1', activationWithheld: true },
          { isActive: true, activationWithheld: false }
        );
      });

      it('CONTROL: an association with no withheld product is never touched, so a product an admin took off sale stays inactive', async () => {
        const { service, productRepo } = makeService();
        // The manually deactivated product has activationWithheld=false, so its association is
        // not in the withheld set at all.
        productRepo.__setWithheld([]);

        expect(await service.releaseWithheldForAllAssociations()).toEqual({
          released: 0,
          failed: 0,
        });
        expect(productRepo.update).not.toHaveBeenCalled();
      });

      it('keeps the products of an association that is still not ready withheld', async () => {
        const { service, assoRepo, productRepo } = makeService();
        productRepo.__setWithheld(['a1']);
        assoRepo.find.mockResolvedValue([{ ...notReady(), id: 'a1' }] as any);

        expect(await service.releaseWithheldForAllAssociations()).toEqual({
          released: 0,
          failed: 0,
        });
        expect(productRepo.update).not.toHaveBeenCalled();
      });

      it('counts a failing association and still releases the others', async () => {
        const { service, assoRepo, productRepo } = makeService();
        productRepo.__setWithheld(['a1', 'a2']);
        assoRepo.find.mockResolvedValue([asso({ id: 'a1' }), asso({ id: 'a2' })] as any);
        // The release re-reads each association under its share lock.
        assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
          Promise.resolve(asso({ id }))
        );
        productRepo.update.mockImplementation(((where: { associationId: string }) =>
          where.associationId === 'a1'
            ? Promise.reject(new Error('db down'))
            : Promise.resolve({ affected: 3 })) as any);

        expect(await service.releaseWithheldForAllAssociations()).toEqual({
          released: 3,
          failed: 1,
        });
      });

      it('SKIPS a withheld product whose association was deleted, so an orphan never fails the sweep', async () => {
        const { service, assoRepo, productRepo } = makeService();
        // `gone` has withheld products left behind by a deleted association (no FK); `a2` exists.
        productRepo.__setWithheld(['gone', 'a2']);
        assoRepo.find.mockResolvedValue([asso({ id: 'a2' })] as any);
        // The release re-reads each association under its share lock.
        assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
          Promise.resolve(asso({ id }))
        );
        productRepo.update.mockResolvedValue({ affected: 1 });

        expect(await service.releaseWithheldForAllAssociations()).toEqual({
          released: 1,
          failed: 0,
        });
        expect(productRepo.update).toHaveBeenCalledTimes(1);
        expect(productRepo.update).toHaveBeenCalledWith(
          { associationId: 'a2', activationWithheld: true },
          { isActive: true, activationWithheld: false }
        );
      });
    });

    it('refuses to put a product on sale while payments cannot be taken', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(notReady());
      productRepo.findOne.mockResolvedValue(product({ isActive: false }));

      // Accepting it would list a product whose every checkout 400s. Refusing says why, once.
      await expect(service.update('asso1', 'prod1', { isActive: true }, false)).rejects.toThrow(
        BadRequestException
      );
    });

    it('hands the state to the admin: setting isActive by hand clears the withheld flag', async () => {
      const { service, assoRepo, productRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        product({ isActive: false, activationWithheld: true } as any)
      );

      await service.update('asso1', 'prod1', { isActive: false }, false);
      const saved = productRepo.save.mock.calls[0][0] as any;
      // Deliberately off sale from now on, so the next onboarding event must leave it alone.
      expect(saved.isActive).toBe(false);
      expect(saved.activationWithheld).toBe(false);
    });
  });

  /**
   * ONE ROW PER CHECKOUT ATTEMPT (migration 101). Before it, every attempt sent Lydia the same
   * order_ref `product:<productId>:<userId>` and Lydia refuses one it has seen (error 3, dev
   * 2026-10-21): after one declined attempt the product was unbuyable, and nothing on Canari's side
   * could tie a payment to anything. Each `it` below fails on that code.
   */
  describe('a checkout is a stored attempt, settled from the row', () => {
    const UUID = (n: number) => n.toString(16).padStart(32, '0');

    /** Routes every core-service payment call to a scripted answer, and records it. */
    function scriptCore(
      httpService: HttpService,
      answers: Record<string, (body: any) => unknown>
    ): Array<{ route: string; body: any }> {
      const calls: Array<{ route: string; body: any }> = [];
      (httpService.post as jest.Mock).mockImplementation((url: string, body: any) => {
        const route = url.split('/payments/')[1];
        calls.push({ route, body });
        const answer = answers[route];
        if (!answer) throw new Error(`unexpected core route ${route}`);
        const out = answer(body);
        return out instanceof Error
          ? throwError(() => out)
          : isObservable(out)
            ? out
            : of({ data: out });
      });
      return calls;
    }

    function setup(overrides: Partial<AssociationProduct> = {}) {
      const made = makeService();
      made.assoRepo.findOne.mockResolvedValue(asso());
      made.productRepo.findOne.mockResolvedValue(product(overrides));
      made.userTagService.hasActiveTag.mockResolvedValue(false);
      // The purchase records ARE the durable state "already purchased" is read from.
      const records: any[] = [];
      made.checkouts.records.rows = records;
      made.purchaseRecordService.create.mockImplementation((x: any) => {
        const rec = { ...x, id: `rec-${records.length + 1}` };
        records.push(rec);
        return Promise.resolve(rec);
      });
      (made.purchaseRecordService.countPaidByUserAndProduct as jest.Mock).mockImplementation(
        (userId: string, productId: string) =>
          Promise.resolve(
            records.filter((r) => r.userId === userId && r.productId === productId).length
          )
      );
      let issued = 0;
      let state = 'open';
      const calls = scriptCore(made.httpService, {
        'create-checkout-session': () => {
          issued += 1;
          return {
            ok: true,
            url: `https://lydia.test/pay/${issued}`,
            id: UUID(issued),
            requestId: `${1000 + issued}`,
          };
        },
        'cancel-request': () => ({ ok: true, outcome: 'cancelled' }),
        'request-state': () => ({ ok: true, state, raw: '?' }),
      });
      return {
        ...made,
        records,
        calls,
        setState: (s: string) => {
          state = s;
        },
        checkout: () => made.service.createCheckoutSession('asso1', 'prod1', 'user1'),
      };
    }

    const orderRefs = (calls: Array<{ route: string; body: any }>) =>
      calls.filter((c) => c.route === 'create-checkout-session').map((c) => c.body.idempotencyKey);

    /** A VERIFIED confirm callback as core hands it over: the attempt, Lydia's id, the Business. */
    const callback = (
      t: ReturnType<typeof setup>,
      checkoutId: string,
      requestId = '1001',
      vendorToken = 'acct_1',
      productId = 'prod1'
    ) => t.service.handlePurchaseCompleted(productId, checkoutId, requestId, vendorToken);

    /** A request/do whose answer never came back: a timeout, no status. */
    const lostOnce = (t: ReturnType<typeof setup>) =>
      (t.httpService.post as jest.Mock).mockImplementationOnce((url: string, body: any) => {
        t.calls.push({ route: url.split('/payments/')[1], body });
        return throwError(() => Object.assign(new Error('timeout of 120000ms exceeded')));
      });

    /** Moves an attempt's clocks back, as if it had been opened `ms` ago. */
    const age = (row: any, ms: number) => {
      row.createdAt = new Date(row.createdAt.getTime() - ms);
      row.expiresAt = new Date(row.expiresAt.getTime() - ms);
    };

    /**
     * THE CERCLE TOP-UP'S "RESERVE AUX COTISANTS" BOX (owner, 2026-10-31) is `membersOnly` on the
     * `balance_topup` product, and `membersOnly` means a COTISANT of the association - an active
     * tier tag of it (`isCotisant`), never a mere member row. Refused with a CODE the shop maps to
     * its own sentence, before any payment request is issued.
     */
    describe('the Cercle top-up reserved to cotisants', () => {
      const topup = {
        type: 'balance_topup' as const,
        membersOnly: true,
        amountCents: null,
        allowCustomAmount: true,
        customAmountMinCents: 100,
        customAmountMaxCents: null,
      };

      it('refuses a non-cotisant at checkout with PRODUCT_COTISANTS_ONLY, and issues nothing', async () => {
        const t = setup(topup);
        t.userTagService.hasActiveTag.mockResolvedValue(false);
        const err = await t.service
          .createCheckoutSession('asso1', 'prod1', 'user1', 500)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          code: 'PRODUCT_COTISANTS_ONLY',
        });
        expect(orderRefs(t.calls)).toHaveLength(0);
        expect(t.checkouts.rows).toHaveLength(0);
      });

      it('CONTROL: opens the checkout of a cotisant, at the amount they chose', async () => {
        const t = setup(topup);
        t.userTagService.hasActiveTag.mockResolvedValue(true);
        const opened = await t.service.createCheckoutSession('asso1', 'prod1', 'user1', 500);
        expect(opened.amountCents).toBe(500);
        expect(orderRefs(t.calls)).toHaveLength(1);
      });

      it('CONTROL: the box unticked (the default) opens it to a non-cotisant', async () => {
        const t = setup({ ...topup, membersOnly: false });
        t.userTagService.hasActiveTag.mockResolvedValue(false);
        const opened = await t.service.createCheckoutSession('asso1', 'prod1', 'user1', 500);
        expect(opened.amountCents).toBe(500);
      });
    });

    it('refuses a product whose association the buyer cannot see as NOT FOUND, and issues nothing', async () => {
      const t = setup();
      (associationVisibleTo as jest.Mock).mockResolvedValueOnce(false);
      await expect(t.checkout()).rejects.toThrow(NotFoundException);
      expect(associationVisibleTo).toHaveBeenCalledWith(expect.anything(), 'asso1', 'user1');
      expect(orderRefs(t.calls)).toHaveLength(0);
      expect(t.checkouts.rows).toHaveLength(0);
    });

    it('gives every attempt its own order_ref, so a retry after a DECLINED one is issued', async () => {
      const t = setup();
      const first = await t.checkout();
      t.setState('declined');
      await t.service.confirmCheckout('asso1', 'prod1', first.checkoutId, 'user1');
      expect(t.checkouts.rows[0].status).toBe('declined');

      const second = await t.checkout();
      const [refA, refB] = orderRefs(t.calls);
      // The control: the old code sent `product:prod1:user1` twice, and Lydia refused the second.
      // The buyer is not in it: the row holds the buyer.
      expect(refA).toBe(`product:prod1:${first.checkoutId}`);
      expect(refB).toBe(`product:prod1:${second.checkoutId}`);
      expect(refA).not.toBe(refB);
      // A declined attempt is not a purchase.
      expect(t.records).toHaveLength(0);
    });

    it('stores the attempt with the request ids, and names it in both return URLs', async () => {
      const t = setup();
      const { checkoutId } = await t.checkout();
      expect(t.checkouts.rows[0]).toMatchObject({
        id: checkoutId,
        productId: 'prod1',
        userId: 'user1',
        associationId: 'asso1',
        paymentAssociationId: 'asso1',
        amountCents: 1000,
        status: 'open',
        requestUuid: UUID(1),
        requestId: '1001',
      });
      const sent = t.calls[0].body;
      expect(sent.successUrl).toContain(`checkout_id=${checkoutId}`);
      expect(sent.cancelUrl).toContain(`checkout_id=${checkoutId}`);
      // An abandoned attempt closes at Lydia instead of staying payable for ever.
      expect(sent.expireAfterSeconds).toBe(30 * 60);
    });

    it("charges a tier rise the admin's preferential price, and settles the amount FROZEN on the row", async () => {
      // Production's shape (2026-10-26): the alcohol tier at 30 EUR carries a preferential price of
      // 15 EUR for holders of the other tier. The complement is that setting - nothing computed.
      const sansAlcool = product({
        id: 'prod-sans',
        type: 'membership',
        variantKey: 'sans-alcool',
        amountCents: 1500,
      });
      const avecAlcool = product({
        type: 'membership',
        variantKey: 'avec-alcool',
        amountCents: 3000,
        memberPriceTag: 'cotisant:cercle-sans-alcool',
        amountCentsMember: 1500,
      });
      const t = setup();
      t.assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
      t.productRepo.findOne.mockResolvedValue(avecAlcool);
      t.productRepo.find.mockResolvedValue([sansAlcool, avecAlcool]);
      t.userTagService.hasActiveTag.mockImplementation((_u: string, tag: string) =>
        Promise.resolve(tag === 'cotisant:cercle-sans-alcool')
      );

      const { checkoutId, amountCents } = await t.checkout();
      expect(amountCents).toBe(1500);
      expect(t.calls[0].body.lineItems[0].price_data.unit_amount).toBe(1500);
      expect(t.checkouts.rows[0]).toMatchObject({ id: checkoutId, amountCents: 1500 });

      // The admin re-prices while the buyer is at Lydia: the settlement records what was ASKED.
      t.productRepo.findOne.mockResolvedValue({ ...avecAlcool, amountCentsMember: 900 });
      t.setState('paid');
      await t.service.confirmCheckout('asso1', 'prod1', checkoutId, 'user1');
      expect(t.records).toHaveLength(1);
      expect(t.records[0]).toMatchObject({ amountCents: 1500 });
    });

    // Nothing is delivered for a product deleted while its buyer was paying: the money is recorded
    // with the marker a refund is owed on, never as an ordinary paid purchase.
    it('a payment for a product deleted meanwhile is recorded paid_not_granted, at ERROR', async () => {
      const t = setup();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { checkoutId } = await t.checkout();
      t.productRepo.findOne.mockResolvedValue(null);
      t.setState('paid');

      await t.service.confirmCheckout('asso1', 'prod1', checkoutId, 'user1');

      expect(t.records).toHaveLength(1);
      expect(t.records[0]).toMatchObject({ status: 'paid_not_granted', productId: 'prod1' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('a refund is owed'));
      expect(t.userTagService.grantOrRenew).not.toHaveBeenCalled();
      error.mockRestore();
    });

    describe('two cotisation tiers of one association never both settle', () => {
      const sans = () =>
        product({
          id: 'prod-sans',
          type: 'membership',
          variantKey: 'sans-alcool',
          amountCents: 1500,
        });
      const avec = () =>
        product({
          id: 'prod-avec',
          type: 'membership',
          variantKey: 'avec-alcool',
          amountCents: 3000,
          grantedTagName: 'cotisant:cercle-avec-alcool',
        });

      /** A Cercle buyer whose held tags the test moves by hand. */
      function cercleBuyer() {
        const t = setup();
        const held = new Set<string>();
        t.assoRepo.findOne.mockResolvedValue(asso({ slug: 'cercle', cotisationMode: 'lifetime' }));
        t.productRepo.findOne.mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve([sans(), avec()].find((p) => p.id === where.id) ?? null)
        );
        t.productRepo.find.mockResolvedValue([sans(), avec()]);
        t.userTagService.hasActiveTag.mockImplementation((_u: string, tag: string) =>
          Promise.resolve(held.has(tag))
        );
        const open = (id: string) => t.service.createCheckoutSession('asso1', id, 'user1');
        return { ...t, held, open };
      }

      it("takes the buyer's tier lock at checkout open and at settlement, keyed on association and buyer", async () => {
        const t = cercleBuyer();
        const { checkoutId } = await t.open('prod-avec');
        t.setState('paid');
        await t.service.confirmCheckout('asso1', 'prod-avec', checkoutId, 'user1');
        const locks = t.checkouts.tx.query.mock.calls.filter(([sql]) =>
          String(sql).includes('pg_advisory_xact_lock(hashtextextended($1, 0))')
        );
        expect(locks.map(([, params]) => params)).toEqual([
          ['tier:asso1:user1'],
          ['tier:asso1:user1'],
        ]);
      });

      it('refuses PAYMENT_ROUTING_CHANGED when the payment account changes while the routing is fetched, and opens nothing', async () => {
        const t = cercleBuyer();
        const fetchProvider = (t.service as any).activePaymentProvider.bind(t.service);
        // The account changes while the call to the other service is in flight, i.e. between the
        // routing decided outside the lock and its re-validation under it.
        jest.spyOn(t.service as any, 'activePaymentProvider').mockImplementation(() => {
          t.assoRepo.findOne.mockResolvedValue(
            asso({ slug: 'cercle', cotisationMode: 'lifetime', lydiaAccountId: 'acct_2' })
          );
          return fetchProvider();
        });

        const err = await t.open('prod-avec').then(
          () => null,
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(ConflictException);
        expect(((err as ConflictException).getResponse() as { code: string }).code).toBe(
          'PAYMENT_ROUTING_CHANGED'
        );
        expect(t.calls.filter((c) => c.route === 'create-checkout-session')).toEqual([]);
        expect(t.checkouts.rows).toEqual([]);
      });

      // EVERY field of the routing is compared, not only the account and the receiving association:
      // a prepared routing that differs in delegation alone is refused like any other change.
      it('refuses PAYMENT_ROUTING_CHANGED when the routing differs in a field other than the account', async () => {
        const t = cercleBuyer();
        const prepared = await (t.service as any).preparePurchase('asso1', 'prod-avec', 'user1');
        const stale = {
          ...prepared,
          paymentTarget: { ...prepared.paymentTarget, delegated: true },
        };

        const err = await (t.service as any)
          .decidePurchase(stale, 'user1', undefined, t.checkouts.tx)
          .then(
            () => null,
            (e: unknown) => e
          );
        expect(((err as ConflictException).getResponse() as { code: string }).code).toBe(
          'PAYMENT_ROUTING_CHANGED'
        );
        // CONTROL: the routing as prepared passes.
        await expect(
          (t.service as any).decidePurchase(prepared, 'user1', undefined, t.checkouts.tx)
        ).resolves.toMatchObject({ amountCents: 3000 });
      });

      it("opening a tier cancels the buyer's open attempt of a SIBLING tier first", async () => {
        const t = cercleBuyer();
        await t.open('prod-sans');
        await t.open('prod-avec');
        expect(t.calls.map((c) => c.route)).toEqual([
          'create-checkout-session',
          'cancel-request',
          'create-checkout-session',
        ]);
        expect(t.checkouts.rows.map((r) => [r.productId, r.status])).toEqual([
          ['prod-sans', 'cancelled'],
          ['prod-avec', 'open'],
        ]);
      });

      it('a sibling paid AFTER a rise is recorded, not granted, and logged at ERROR', async () => {
        const t = cercleBuyer();
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const { checkoutId } = await t.open('prod-sans');
        // Meanwhile the buyer obtained the dearer tier (another path: a grant, another attempt).
        t.held.add('cotisant:cercle-avec-alcool');
        t.setState('paid');
        await t.service.confirmCheckout('asso1', 'prod-sans', checkoutId, 'user1');

        expect(t.records).toHaveLength(1);
        expect(t.records[0]).toMatchObject({ productId: 'prod-sans', amountCents: 1500 });
        expect(t.userTagService.grantOrRenew).not.toHaveBeenCalled();
        expect(t.userTagService.revokeSiblingTierTags).not.toHaveBeenCalled();
        expect(error.mock.calls.some(([m]) => String(m).includes('a refund is owed'))).toBe(true);
        error.mockRestore();
      });

      it('the opening freezes the tier it ranked against on the attempt row, and nothing when none is held', async () => {
        const t = cercleBuyer();
        await t.open('prod-sans');
        t.held.add('cotisant:cercle-sans-alcool');
        await t.open('prod-avec');
        expect(t.checkouts.rows.map((r) => [r.productId, r.heldTierProductId])).toEqual([
          ['prod-sans', null],
          ['prod-avec', 'prod-sans'],
        ]);
      });

      it('a rise whose price an admin lowered after the opening is GRANTED on what the opening decided', async () => {
        const t = cercleBuyer();
        t.held.add('cotisant:cercle-sans-alcool');
        const { checkoutId } = await t.open('prod-avec');
        // Ranked on today's prices, 1000 under the held 1500 would be `lower`; it is never re-read.
        const lowered = () => ({ ...avec(), amountCents: 1000 });
        t.productRepo.findOne.mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve([sans(), lowered()].find((p) => p.id === where.id) ?? null)
        );
        t.productRepo.find.mockResolvedValue([sans(), lowered()]);
        t.setState('paid');
        await t.service.confirmCheckout('asso1', 'prod-avec', checkoutId, 'user1');
        expect(t.records[0]).toMatchObject({ productId: 'prod-avec', status: 'paid' });
        expect(t.userTagService.revokeSiblingTierTags).toHaveBeenCalled();
      });

      it('a rise paid as planned is granted, with the XOR', async () => {
        const t = cercleBuyer();
        t.held.add('cotisant:cercle-sans-alcool');
        const { checkoutId } = await t.open('prod-avec');
        t.setState('paid');
        await t.service.confirmCheckout('asso1', 'prod-avec', checkoutId, 'user1');
        expect(t.userTagService.revokeSiblingTierTags).toHaveBeenCalledWith(
          'asso1',
          'user1',
          'avec-alcool',
          expect.anything()
        );
      });
    });

    it('cancels the still-open attempt at Lydia before issuing the next one', async () => {
      const t = setup({ allowRepeatPurchase: true });
      await t.checkout();
      await t.checkout();
      expect(t.calls.map((c) => c.route)).toEqual([
        'create-checkout-session',
        'cancel-request',
        'create-checkout-session',
      ]);
      expect(t.calls[1].body).toEqual({ requestId: '1001', connectAccountId: 'acct_1' });
      expect(t.checkouts.rows.map((r) => r.status)).toEqual(['cancelled', 'open']);
    });

    it('records a PAID attempt once, from the row, and then refuses a second purchase before any request', async () => {
      const t = setup();
      const { checkoutId } = await t.checkout();
      t.setState('paid');
      await expect(
        t.service.confirmCheckout('asso1', 'prod1', checkoutId, 'user1')
      ).resolves.toMatchObject({ status: 'paid' });
      // A second read, and the callback (a replay), find it paid: nothing is recorded twice.
      await t.service.confirmCheckout('asso1', 'prod1', checkoutId, 'user1');
      await expect(callback(t, checkoutId)).resolves.toEqual({ outcome: 'paid' });
      await expect(callback(t, checkoutId)).resolves.toEqual({ outcome: 'paid' });
      expect(t.records).toHaveLength(1);
      expect(t.records[0]).toMatchObject({
        amountCents: 1000,
        productId: 'prod1',
        stripePaymentIntentId: '1001',
      });
      expect(t.checkouts.rows[0]).toMatchObject({ status: 'paid', purchaseRecordId: 'rec-1' });

      const before = t.calls.length;
      const refusal = await t.checkout().catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        code: 'PRODUCT_ALREADY_PURCHASED',
      });
      // Decided by Canari: no request/do was sent for the refused purchase.
      expect(t.calls.slice(before).map((c) => c.route)).not.toContain('create-checkout-session');
    });

    it('records the purchase found PAID while settling the previous attempt, and issues nothing more', async () => {
      const t = setup();
      await t.checkout();
      // The buyer paid in another tab: the cancel answers "already settled", the state says paid.
      t.calls.length = 0;
      (t.httpService.post as jest.Mock).mockImplementation((url: string) => {
        const route = url.split('/payments/')[1];
        t.calls.push({ route, body: null });
        if (route === 'cancel-request')
          return of({ data: { ok: true, outcome: 'already-settled' } });
        if (route === 'request-state') return of({ data: { ok: true, state: 'paid', raw: '1' } });
        throw new Error(`unexpected ${route}`);
      });
      await expect(t.checkout()).rejects.toBeInstanceOf(ConflictException);
      expect(t.records).toHaveLength(1);
      expect(t.calls.map((c) => c.route)).toEqual(['cancel-request', 'request-state']);
    });

    it("records the ROW's amount, whatever the product costs by the time it is paid", async () => {
      const t = setup();
      const { checkoutId } = await t.checkout();
      t.productRepo.findOne.mockResolvedValue(product({ amountCents: 1 }));
      t.setState('paid');
      await callback(t, checkoutId);
      expect(t.records).toHaveLength(1);
      expect(t.records[0].amountCents).toBe(1000);
    });

    it.each([
      [
        'no stored attempt',
        (id: string) => [`00000000-0000-4000-8000-00000000ffff`, '1001', 'acct_1', 'prod1', id],
      ],
      ['an attempt of another product', (id: string) => [id, '1001', 'acct_1', 'prod2']],
      [
        'another request than the attempt stored',
        (id: string) => [id, '999999', 'acct_1', 'prod1'],
      ],
      // An authentic callback of association A never settles B's attempt.
      [
        'a Business the attempt was not issued to',
        (id: string) => [id, '1001', 'acct_other', 'prod1'],
      ],
    ])('records nothing, at ERROR, for a callback naming %s', async (_case, args) => {
      const t = setup();
      const { checkoutId } = await t.checkout();
      t.setState('paid');
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const [id, requestId, vendor, productId] = args(checkoutId) as string[];
      await expect(callback(t, id, requestId, vendor, productId)).resolves.toEqual({
        outcome: 'refused',
      });
      expect(error).toHaveBeenCalled();
      expect(t.records).toHaveLength(0);
      expect(t.calls.map((c) => c.route)).not.toContain('request-state');
      error.mockRestore();
    });

    it("answers another buyer's attempt as not found, without asking Lydia", async () => {
      const t = setup();
      const { checkoutId } = await t.checkout();
      t.setState('paid');
      for (const [assoc, prod, user] of [
        ['asso1', 'prod1', 'intruder'],
        ['asso2', 'prod1', 'user1'],
        ['asso1', 'prod2', 'user1'],
      ]) {
        await expect(
          t.service.confirmCheckout(assoc, prod, checkoutId, user)
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(t.calls.map((c) => c.route)).not.toContain('request-state');
      expect(t.records).toHaveLength(0);
    });

    it('closes a state-6 attempt as cancelled before its expiry and as expired after it', async () => {
      const t = setup({ allowRepeatPurchase: true });
      const a = await t.checkout();
      t.setState('cancelled-or-expired');
      await t.service.confirmCheckout('asso1', 'prod1', a.checkoutId, 'user1');
      const b = await t.checkout();
      t.checkouts.rows[1].expiresAt = new Date(Date.now() - 1000);
      await t.service.confirmCheckout('asso1', 'prod1', b.checkoutId, 'user1');
      expect(t.checkouts.rows.map((r) => r.status)).toEqual(['cancelled', 'expired']);
    });

    it('answers a double click CHECKOUT_IN_PROGRESS and issues ONE request', async () => {
      const t = setup();
      const pending = new Subject<{ data: unknown }>();
      (t.httpService.post as jest.Mock).mockImplementation((url: string) => {
        t.calls.push({ route: url.split('/payments/')[1], body: null });
        return pending;
      });
      const first = t.checkout();
      await new Promise((r) => setImmediate(r));
      const second = await t.checkout().catch((e: unknown) => e);
      expect((second as ConflictException).getResponse()).toMatchObject({
        code: 'CHECKOUT_IN_PROGRESS',
      });
      pending.next({
        data: { ok: true, url: 'https://lydia.test/pay/1', id: UUID(1), requestId: '1001' },
      });
      await expect(first).resolves.toMatchObject({ checkoutUrl: 'https://lydia.test/pay/1' });
      expect(t.calls.filter((c) => c.route === 'create-checkout-session')).toHaveLength(1);
    });

    it('refuses a second OPEN row for one product and buyer, as the partial unique index does', async () => {
      const t = setup();
      t.checkouts.rows.push({
        id: 'other',
        productId: 'prod1',
        userId: 'user1',
        status: 'open',
        requestUuid: null,
        requestId: null,
        // Written between this request's settle and its insert by a concurrent one.
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      // Hide it from the settle step only, so the insert is what meets it.
      t.checkouts.repo.findOne.mockResolvedValueOnce(null);
      const refusal = await t.checkout().catch((e: unknown) => e);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        code: 'CHECKOUT_IN_PROGRESS',
      });
      expect(t.calls).toHaveLength(0);
    });

    it('releases an attempt core REFUSED to issue (a 4xx answer), so the retry is not blocked', async () => {
      const t = setup();
      (t.httpService.post as jest.Mock).mockImplementationOnce(() =>
        throwError(() =>
          Object.assign(new Error('refused'), {
            response: { status: 400, data: { message: 'Lydia accepts payments from 0.50' } },
          })
        )
      );
      await expect(t.checkout()).rejects.toThrow('Lydia accepts payments from 0.50');
      expect(t.checkouts.rows[0].status).toBe('cancelled');
      const retry = await t.checkout();
      expect(retry.checkoutId).toBe(t.checkouts.rows[1].id);
      expect(t.checkouts.rows[1].status).toBe('open');
    });

    it.each([
      ['LYDIA_BUSINESS_NOT_VALIDATED', 'request-refused', 'PAYMENTS_NOT_ACTIVATED'],
      ['LYDIA_BUSINESS_BLOCKED', 'request-blocked', 'PAYMENTS_BLOCKED'],
    ])(
      'core`s %s (error 5 / 2701): the attempt released, the HOLDER reverted (%s), the payer`s typed 409 %s',
      async (coreCode, cause, payerCode) => {
        const t = setup();
        (t.httpService.post as jest.Mock).mockImplementationOnce(() =>
          throwError(() =>
            Object.assign(new Error('refused'), {
              response: { status: 400, data: { code: coreCode, providerCode: '5' } },
            })
          )
        );
        const refusal = await t.checkout().catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(ConflictException);
        expect((refusal as ConflictException).getResponse()).toMatchObject({ code: payerCode });
        expect(t.checkouts.rows[0].status).toBe('cancelled');
        expect(t.associationsService.revertLydiaReadinessAfterRefusal).toHaveBeenCalledWith(
          'acct_1',
          cause,
          { path: 'shop', id: t.checkouts.rows[0].id }
        );
      }
    );

    it('any other refusal, or a LOST request, reverts nothing', async () => {
      const t = setup();
      (t.httpService.post as jest.Mock).mockImplementationOnce(() =>
        throwError(() =>
          Object.assign(new Error('refused'), {
            response: {
              status: 400,
              data: { code: 'PAYMENT_PROVIDER_REFUSED', providerCode: '104' },
            },
          })
        )
      );
      await t.checkout().catch(() => undefined);
      lostOnce(t);
      await t.checkout().catch(() => undefined);
      expect(t.associationsService.revertLydiaReadinessAfterRefusal).not.toHaveBeenCalled();
    });

    it('a revert landing between the prepare and the decision answers the typed 409, and issues NO request', async () => {
      const t = setup();
      const prepare = (t.service as any).preparePurchase.bind(t.service);
      jest
        .spyOn(t.service as any, 'preparePurchase')
        .mockImplementation(async (...args: unknown[]) => {
          const prepared = await prepare(...args);
          // The revert commits here: every read after this one sees the holder NOT ready.
          t.assoRepo.findOne.mockResolvedValue(
            asso({ lydiaOnboardingComplete: false, lydiaReadinessCause: 'request-blocked' })
          );
          return prepared;
        });
      const refusal = await t.checkout().catch((e: unknown) => e);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        code: 'PAYMENTS_BLOCKED',
      });
      expect(t.calls.filter((c) => c.route === 'create-checkout-session')).toEqual([]);
      expect(t.checkouts.rows).toHaveLength(0);
    });

    describe('an attempt whose request/do was LOST (no answer) is read by its order_ref', () => {
      it('is left OPEN, never closed on a guess, and answers the 502', async () => {
        const t = setup();
        lostOnce(t);
        await expect(t.checkout()).rejects.toThrow(
          'The payment service could not create the checkout session'
        );
        // The control: the first draft of #2218 closed it `cancelled` here, and a payment Lydia
        // took for it afterwards found no attempt to settle.
        expect(t.checkouts.rows[0]).toMatchObject({ status: 'open', requestUuid: null });
      });

      it('is SETTLED by its confirm callback, found by the attempt id and read at Lydia by order_ref', async () => {
        const t = setup();
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        const checkoutId = t.checkouts.rows[0].id;
        t.setState('paid');
        await expect(callback(t, checkoutId)).resolves.toEqual({ outcome: 'paid' });
        const read = t.calls.find((c) => c.route === 'request-state');
        expect(read?.body).toEqual({
          orderRef: `product:prod1:${checkoutId}`,
          connectAccountId: 'acct_1',
        });
        expect(t.records).toHaveLength(1);
        expect(t.records[0]).toMatchObject({ amountCents: 1000, userId: 'user1' });
        expect(t.checkouts.rows[0].status).toBe('paid');
      });

      it('blocks a retry while it may still be in flight, then reads it: never issued, it closes', async () => {
        const t = setup();
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        const inFlight = await t.checkout().catch((e: unknown) => e);
        expect((inFlight as ConflictException).getResponse()).toMatchObject({
          code: 'CHECKOUT_IN_PROGRESS',
        });

        age(t.checkouts.rows[0], 4 * 60_000);
        t.setState('not-found');
        const retry = await t.checkout();
        expect(t.checkouts.rows[0].status).toBe('cancelled');
        expect(retry.checkoutId).toBe(t.checkouts.rows[1].id);
        expect(t.calls.filter((c) => c.route === 'request-state')[0].body).toMatchObject({
          orderRef: `product:prod1:${t.checkouts.rows[0].id}`,
        });
      });

      it('records it when the retry finds it PAID at Lydia, and issues nothing more', async () => {
        const t = setup();
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        age(t.checkouts.rows[0], 4 * 60_000);
        t.setState('paid');
        const refusal = await t.checkout().catch((e: unknown) => e);
        expect((refusal as ConflictException).getResponse()).toMatchObject({
          code: 'PRODUCT_ALREADY_PURCHASED',
        });
        expect(t.records).toHaveLength(1);
        expect(t.calls.filter((c) => c.route === 'create-checkout-session')).toHaveLength(1);
      });

      /** A Cercle top-up product, its dispatch observed rather than sent. */
      const topUp = () => {
        const t = setup({
          type: 'balance_topup',
          webhookUrl: 'https://cercle.test/hook',
          webhookSecret: 'test-secret',
        } as Partial<AssociationProduct>);
        const dispatch = jest
          .spyOn(t.service, 'dispatchCercleWebhook')
          .mockResolvedValue(undefined as never);
        return { t, dispatch };
      };

      it("settles a top-up under the CALLBACK's request id: the record names it, Cercle is credited", async () => {
        const { t, dispatch } = topUp();
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        const checkoutId = t.checkouts.rows[0].id;
        t.setState('paid');
        await expect(callback(t, checkoutId, '1001')).resolves.toEqual({ outcome: 'paid' });
        // The control: settled with no request id, the record named no payment and the top-up was
        // skipped without a line - the buyer paid and the Cercle balance never moved.
        expect(t.checkouts.rows[0].requestId).toBe('1001');
        expect(t.records[0].stripePaymentIntentId).toBe('1001');
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'user1', 1000, '1001');
      });

      it('grants the tag of an online payment settled by order_ref as an ONLINE grant, not a manual one', async () => {
        const t = setup({ type: 'membership', grantedTagName: 'cotisant:bde' } as any);
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        t.setState('paid');
        await callback(t, t.checkouts.rows[0].id, '1001');
        expect(t.userTagService.grantOrRenew).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({ paymentIntentId: '1001', manualGrant: false }),
          }),
          expect.anything()
        );
      });

      it('a top-up paid on the RETURN before any id is known is logged, then credited once by the callback', async () => {
        const { t, dispatch } = topUp();
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        const row = t.checkouts.rows[0];
        age(row, 4 * 60_000);
        t.setState('paid');
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        await t.service.confirmCheckout('asso1', 'prod1', row.id, 'user1');
        expect(row.status).toBe('paid');
        expect(t.records[0].stripePaymentIntentId).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('top-up NOT dispatched'));
        error.mockRestore();

        await expect(callback(t, row.id, '1001')).resolves.toEqual({ outcome: 'paid' });
        await expect(callback(t, row.id, '1001')).resolves.toEqual({ outcome: 'paid' });
        expect(t.records).toHaveLength(1);
        expect(t.records[0].stripePaymentIntentId).toBe('1001');
        // Lydia retries a callback: the second one completes nothing and credits nothing.
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'user1', 1000, '1001');
      });

      it('credits a top-up the RETURN settled while the callback held a stale open snapshot', async () => {
        const { t, dispatch } = topUp();
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        const row = t.checkouts.rows[0];
        age(row, 4 * 60_000);
        t.setState('paid');
        // The callback's unlocked read sees the attempt OPEN; the return then settles it, no id.
        const stale = { ...row };
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        await t.service.confirmCheckout('asso1', 'prod1', row.id, 'user1');
        expect(row.status).toBe('paid');
        t.checkouts.repo.findOne.mockResolvedValueOnce(stale);

        await expect(callback(t, row.id, '1001')).resolves.toEqual({ outcome: 'paid' });
        // The control: the snapshot said open, so the callback went through the settlement, which
        // found the row paid and recorded nothing - and the record was never completed.
        expect(t.records).toHaveLength(1);
        expect(t.records[0].stripePaymentIntentId).toBe('1001');
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'user1', 1000, '1001');
        error.mockRestore();
      });

      it('refuses a callback naming ANOTHER request than the one a racing write stored', async () => {
        const t = setup();
        lostOnce(t);
        await t.checkout().catch(() => undefined);
        const row = t.checkouts.rows[0];
        row.requestId = '2002';
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        await expect(callback(t, row.id, '1001')).resolves.toEqual({ outcome: 'refused' });
        expect(t.records).toHaveLength(0);
        error.mockRestore();
      });
    });

    describe('an attempt whose fate cannot be shown stops blocking its buyer at its expiry', () => {
      it.each([
        ['Lydia still answers open', (t: ReturnType<typeof setup>) => t.setState('open')],
        [
          'its request cannot be read at Lydia',
          (t: ReturnType<typeof setup>) =>
            (t.httpService.post as jest.Mock).mockImplementation((url: string, body: any) => {
              const route = url.split('/payments/')[1];
              t.calls.push({ route, body });
              return route === 'cancel-request'
                ? of({ data: { ok: true, outcome: 'already-settled' } })
                : throwError(() => new Error('socket hang up'));
            }),
        ],
      ])(
        'refuses before expiresAt + 5 min and closes it expired after, when %s',
        async (_c, arrange) => {
          const t = setup({ allowRepeatPurchase: true });
          await t.checkout();
          // The cancel cannot prove it dead: Lydia says processed, so the state must decide.
          (t.httpService.post as jest.Mock).mockImplementation((url: string, body: any) => {
            const route = url.split('/payments/')[1];
            t.calls.push({ route, body });
            if (route === 'cancel-request')
              return of({ data: { ok: true, outcome: 'already-settled' } });
            if (route === 'request-state')
              return of({ data: { ok: true, state: 'open', raw: '0' } });
            return of({
              data: { ok: true, url: 'https://lydia.test/pay/2', id: UUID(2), requestId: '1002' },
            });
          });
          arrange(t);
          const refusal = await t.checkout().catch((e: unknown) => e);
          expect((refusal as ConflictException).getResponse()).toMatchObject({
            code: 'PREVIOUS_CHECKOUT_OPEN',
            message: expect.stringContaining('35 minutes'),
          });

          // The control: without the expiry exit this attempt refused its buyer for ever.
          const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
          age(t.checkouts.rows[0], 36 * 60_000);
          t.assoRepo.findOne.mockResolvedValue(asso());
          arrange(t);
          const settled = await (t.service as any).settlePreviousOpenAttempt('prod1', 'user1');
          expect(settled).toBeUndefined();
          expect(t.checkouts.rows[0].status).toBe('expired');
          expect(error).toHaveBeenCalledWith(expect.stringContaining('closed as expired'));
          error.mockRestore();
        }
      );
    });

    it('records a PAID answer over a closed attempt, and logs it at ERROR as a charge to check', async () => {
      const t = setup();
      const { checkoutId } = await t.checkout();
      t.setState('cancelled-or-expired');
      await t.service.confirmCheckout('asso1', 'prod1', checkoutId, 'user1');
      expect(t.checkouts.rows[0].status).toBe('cancelled');
      t.setState('paid');
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await expect(callback(t, checkoutId)).resolves.toEqual({ outcome: 'paid' });
      expect(t.records).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('charge to refund'));
      error.mockRestore();
    });

    it('answers unreadable, recording nothing, when Lydia cannot be asked - so core answers the retryable 503', async () => {
      const t = setup();
      const { checkoutId } = await t.checkout();
      (t.httpService.post as jest.Mock).mockImplementation(() =>
        throwError(() => new Error('ECONNRESET'))
      );
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await expect(callback(t, checkoutId)).resolves.toEqual({ outcome: 'unreadable' });
      expect(t.records).toHaveLength(0);
      error.mockRestore();
    });
  });
});
