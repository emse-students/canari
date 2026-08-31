import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { of } from 'rxjs';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ProductsService } from './products.service';
import { AssociationProduct } from './entities/association-product.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { Association } from './entities/association.entity';
import { AssociationsService } from './associations.service';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { UserTagService } from '../users/user-tag.service';
import { PurchaseRecordService } from '../users/purchase-record.service';

describe('ProductsService cotisation gating/pricing and Cercle re-gating', () => {
  function makeService() {
    const manager: any = {
      query: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    manager.transaction = jest.fn((cb: (m: unknown) => unknown) => cb(manager));
    const productRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      update: jest.fn(() => Promise.resolve({ affected: 0 })),
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
    };
    const httpService = {
      post: jest.fn(() => of({ data: {} })),
      // Active payment provider, polled via fetchActivePaymentProvider() - stripe by default,
      // matching the `asso()` factory below (stripeAccountId/stripeOnboardingComplete).
      get: jest.fn(() => of({ data: { provider: 'stripe' } })),
    } as unknown as HttpService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    const userTagService = {
      hasActiveTag: jest.fn(),
      getActiveTag: jest.fn(
        (_userId: string, _tagName: string): Promise<{ expiresAt: Date | null } | null> =>
          Promise.resolve(null)
      ),
      listByUser: jest.fn(() => Promise.resolve([])),
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
    };
    // Only reached by a product carrying a pricing grid; the default fixtures carry none.
    const pricingFacts = {
      build: jest.fn(() =>
        Promise.resolve({ promo: null, formation: null, cotisationTiers: [], answers: {} })
      ),
      profileFor: jest.fn(() => Promise.resolve({ promo: null, formation: null })),
    };

    const service = new ProductsService(
      productRepo as unknown as Repository<AssociationProduct>,
      deliveryRepo as unknown as Repository<WebhookDelivery>,
      assoRepo as unknown as Repository<Association>,
      httpService,
      config,
      userTagService as unknown as UserTagService,
      purchaseRecordService as unknown as PurchaseRecordService,
      associationsService as unknown as AssociationsService,
      pricingFacts as unknown as PricingFactsService
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
    };
  }

  const asso = (overrides: Partial<Association> = {}): Association =>
    ({
      id: 'asso1',
      slug: 'bde',
      stripeOnboardingComplete: true,
      stripeAccountId: 'acct_1',
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
    expect(userTagService.hasActiveTag).toHaveBeenCalledWith('user1', 'cotisant:bde');
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
    it('routes a delegating club purchase to the approved parent Stripe account', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const club = asso({
        id: 'club1',
        stripeOnboardingComplete: false,
        stripeAccountId: null,
        paymentParentAssociationId: 'parent1',
        paymentDelegationStatus: 'approved',
      });
      const parent = asso({
        id: 'parent1',
        stripeOnboardingComplete: true,
        stripeAccountId: 'acct_parent',
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
        stripeOnboardingComplete: false,
        stripeAccountId: null,
        paymentParentAssociationId: 'parent1',
        paymentDelegationStatus: 'approved',
      });
      const parent = asso({
        id: 'parent1',
        stripeOnboardingComplete: false,
        stripeAccountId: null,
      });
      assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(id === 'parent1' ? parent : club)
      );
      productRepo.findOne.mockResolvedValue(product({ associationId: 'club1' }));

      await expect((service as any).resolvePurchase('club1', 'prod1', 'user1')).rejects.toThrow(
        /delegates payments/
      );
    });

    it('ignores a pending (unapproved) delegation and uses the club own account', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const club = asso({
        id: 'club1',
        stripeOnboardingComplete: true,
        stripeAccountId: 'acct_club',
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
        })
      );
      expect(created).toBeDefined();
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

      const grant = await (service as any).resolveGrantTag(stale);
      expect(grant.tagName).toMatch(/^cotisant:bde-\d{4}-\d{4}$/);
      expect(grant.tagName).not.toBe('cotisant:bde-2000-2001');
      expect(grant.expiresAt).toBeInstanceOf(Date);
    });

    it('falls back to the stored tag for a membership product without a cotisation mode', async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: null }));
      const legacy = product({
        type: 'membership',
        grantedTagName: 'cotisant:legacy',
        tagExpiresAt: null,
      });

      const grant = await (service as any).resolveGrantTag(legacy);
      expect(grant.tagName).toBe('cotisant:legacy');
      expect(grant.expiresAt).toBeNull();
    });

    it('returns null for a non-membership product', async () => {
      const { service } = makeService();
      const grant = await (service as any).resolveGrantTag(product({ type: 'other' }));
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
      const { service, productRepo, purchaseRecordService } = makeService();
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
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethod: 'cash', amountCents: 500 })
      );
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
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === 'cotisant:cercle-sans-alcool')
      );

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(300);
      expect(userTagService.hasActiveTag).toHaveBeenCalledWith(
        'user1',
        'cotisant:cercle-sans-alcool'
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

      const grant = await (service as any).resolveGrantTag(tiered);
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
        (service as any).assertCanPurchase(topup, 'user1', true)
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

      await expect((service as any).assertCanPurchase(avecAlcool, 'user1', true)).rejects.toThrow(
        'You have already purchased this product'
      );
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
        (service as any).assertCanPurchase(sansAlcool, 'user1', true)
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
      userTagService.hasActiveTag.mockResolvedValue(false);

      await expect((service as any).resolvePurchase('asso1', 'prod1', 'user1')).rejects.toThrow(
        ForbiddenException
      );
    });

    it('allows a purchase when the buyer holds ANY of the requiredTags', async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(product({ requiredTags: ['tag:a', 'tag:b'] }));
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === 'tag:b')
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
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === 'tag:vip')
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
      userTagService.listByUser.mockResolvedValue([{ tagName: 'cotisant:cercle-sans-alcool' }]);

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
      pricingFacts.build.mockResolvedValue({
        promo: 2024,
        formation: 'ICM',
        cotisationTiers: [],
        answers: {},
      });

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(9000);
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
      pricingFacts.build.mockResolvedValue({
        promo: 2024,
        formation: null,
        cotisationTiers: [],
        answers: {},
      });

      await expect((service as any).resolvePurchase('asso1', 'prod1', 'user1')).rejects.toThrow(
        BadRequestException
      );
    });

    it('does not ask core-service for a profile when no dimension needs one', async () => {
      const { service, productRepo, assoRepo, pricingFacts } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
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
      pricingFacts.build.mockResolvedValue({
        promo: null,
        formation: null,
        cotisationTiers: [null],
        answers: {},
      });

      const result = await (service as any).resolvePurchase('asso1', 'prod1', 'user1');
      expect(result.amountCents).toBe(500);
      // The point of the flag: a grid resting only on cotisation must not be blocked by, or wait
      // on, a service it does not need.
      expect(pricingFacts.build).toHaveBeenCalledWith(
        expect.objectContaining({ needProfile: false })
      );
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
      asso({ stripeOnboardingComplete: false, stripeAccountId: null, cotisationMode: null });

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
        stripeOnboardingComplete: false,
        stripeAccountId: null,
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
});
