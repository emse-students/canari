import { ForbiddenException } from "@nestjs/common";
import { Repository } from "typeorm";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { ProductsService } from "./products.service";
import { AssociationProduct } from "./entities/association-product.entity";
import { WebhookDelivery } from "./entities/webhook-delivery.entity";
import { Association } from "./entities/association.entity";
import { UserTagService } from "../users/user-tag.service";
import { PurchaseRecordService } from "../users/purchase-record.service";

describe("ProductsService cotisation gating/pricing and Cercle re-gating", () => {
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
      manager,
    };
    const deliveryRepo = {};
    const assoRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
    };
    const httpService = {} as HttpService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    const userTagService = {
      hasActiveTag: jest.fn(),
      getActiveTag: jest.fn(
        (_userId: string, _tagName: string): Promise<{ expiresAt: Date | null } | null> =>
          Promise.resolve(null),
      ),
      listByUser: jest.fn(() => Promise.resolve([])),
      grantOrRenew: jest.fn(() => Promise.resolve({})),
      revokeByName: jest.fn(() => Promise.resolve()),
    };
    const purchaseRecordService = {
      countPaidByUserAndProduct: jest.fn(() => Promise.resolve(0)),
      countPaidByProduct: jest.fn(() => Promise.resolve(0)),
      create: jest.fn((x: unknown) => Promise.resolve(x)),
    };

    const service = new ProductsService(
      productRepo as unknown as Repository<AssociationProduct>,
      deliveryRepo as Repository<WebhookDelivery>,
      assoRepo as unknown as Repository<Association>,
      httpService,
      config,
      userTagService as unknown as UserTagService,
      purchaseRecordService as unknown as PurchaseRecordService,
    );

    return { service, productRepo, assoRepo, userTagService, purchaseRecordService, manager };
  }

  const asso = (overrides: Partial<Association> = {}): Association =>
    ({
      id: "asso1",
      slug: "bde",
      stripeOnboardingComplete: true,
      stripeAccountId: "acct_1",
      cotisationEnabled: true,
      cotisationMode: "lifetime",
      cotisationExpiresAt: null,
      ...overrides,
    }) as Association;

  const product = (overrides: Partial<AssociationProduct> = {}): AssociationProduct =>
    ({
      id: "prod1",
      associationId: "asso1",
      amountCents: 1000,
      currency: "eur",
      type: "other",
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

  it("rejects a members-only purchase when the buyer is not a cotisant", async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ membersOnly: true }));
    userTagService.hasActiveTag.mockResolvedValue(false);

    await expect((service as any).resolvePurchase("asso1", "prod1", "user1")).rejects.toThrow(
      ForbiddenException,
    );
    expect(userTagService.hasActiveTag).toHaveBeenCalledWith("user1", "cotisant:bde");
  });

  it("allows a members-only purchase when the buyer holds the cotisation tag", async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ membersOnly: true }));
    userTagService.hasActiveTag.mockResolvedValue(true);

    const result = await (service as any).resolvePurchase("asso1", "prod1", "user1");
    expect(result.amountCents).toBe(1000);
  });

  it("charges the reduced member price when the buyer is a cotisant and amountCentsMember is set", async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ amountCentsMember: 500 }));
    userTagService.hasActiveTag.mockResolvedValue(true);

    const result = await (service as any).resolvePurchase("asso1", "prod1", "user1");
    expect(result.amountCents).toBe(500);
  });

  it("charges the full price when the buyer is not a cotisant even if amountCentsMember is set", async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso());
    productRepo.findOne.mockResolvedValue(product({ amountCentsMember: 500 }));
    userTagService.hasActiveTag.mockResolvedValue(false);

    const result = await (service as any).resolvePurchase("asso1", "prod1", "user1");
    expect(result.amountCents).toBe(1000);
  });

  it("derives the dated cotisation tag for member pricing/gating checks", async () => {
    const { service, productRepo, assoRepo, userTagService } = makeService();
    assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: "dated" }));
    productRepo.findOne.mockResolvedValue(product({ membersOnly: true }));
    userTagService.hasActiveTag.mockResolvedValue(true);

    await (service as any).resolvePurchase("asso1", "prod1", "user1");
    const [, tagName] = userTagService.hasActiveTag.mock.calls[0];
    expect(tagName).toMatch(/^cotisant:bde-\d{4}-\d{4}$/);
  });

  describe("parent-payment delegation routing", () => {
    it("routes a delegating club purchase to the approved parent Stripe account", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const club = asso({
        id: "club1",
        stripeOnboardingComplete: false,
        stripeAccountId: null,
        paymentParentAssociationId: "parent1",
        paymentDelegationStatus: "approved",
      });
      const parent = asso({
        id: "parent1",
        stripeOnboardingComplete: true,
        stripeAccountId: "acct_parent",
      });
      assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(id === "parent1" ? parent : club),
      );
      productRepo.findOne.mockResolvedValue(product({ associationId: "club1" }));
      userTagService.hasActiveTag.mockResolvedValue(false);

      const result = await (service as any).resolvePurchase("club1", "prod1", "user1");
      expect(result.paymentTarget.stripeAccountId).toBe("acct_parent");
      expect(result.paymentTarget.delegated).toBe(true);
    });

    it("rejects a delegating club purchase when the parent has not completed onboarding", async () => {
      const { service, productRepo, assoRepo } = makeService();
      const club = asso({
        id: "club1",
        stripeOnboardingComplete: false,
        stripeAccountId: null,
        paymentParentAssociationId: "parent1",
        paymentDelegationStatus: "approved",
      });
      const parent = asso({
        id: "parent1",
        stripeOnboardingComplete: false,
        stripeAccountId: null,
      });
      assoRepo.findOne.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(id === "parent1" ? parent : club),
      );
      productRepo.findOne.mockResolvedValue(product({ associationId: "club1" }));

      await expect((service as any).resolvePurchase("club1", "prod1", "user1")).rejects.toThrow(
        /delegates payments/,
      );
    });

    it("ignores a pending (unapproved) delegation and uses the club own account", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const club = asso({
        id: "club1",
        stripeOnboardingComplete: true,
        stripeAccountId: "acct_club",
        paymentParentAssociationId: "parent1",
        paymentDelegationStatus: "pending",
      });
      assoRepo.findOne.mockResolvedValue(club);
      productRepo.findOne.mockResolvedValue(product({ associationId: "club1" }));
      userTagService.hasActiveTag.mockResolvedValue(false);

      const result = await (service as any).resolvePurchase("club1", "prod1", "user1");
      expect(result.paymentTarget.stripeAccountId).toBe("acct_club");
      expect(result.paymentTarget.delegated).toBe(false);
    });
  });

  describe("cotisation config provisioning", () => {
    it("creates the canonical membership product when none exists", async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(null);

      const created = await service.provisionCotisationProduct(asso());

      expect(productRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          associationId: "asso1",
          type: "membership",
          grantedTagName: "cotisant:bde",
          tagExpiresAt: null,
        }),
      );
      expect(created).toBeDefined();
    });

    it("re-syncs the tag on an existing canonical product without touching its name/price", async () => {
      const { service, productRepo } = makeService();
      const existing = product({
        type: "membership",
        name: "Cotisation BDE annuelle",
        amountCents: 2000,
        grantedTagName: "cotisant:old-tag",
      });
      productRepo.findOne.mockResolvedValue(existing);

      const result = await service.provisionCotisationProduct(asso());

      expect(result.grantedTagName).toBe("cotisant:bde");
      expect(result.name).toBe("Cotisation BDE annuelle");
      expect(result.amountCents).toBe(2000);
    });

    it("throws when cotisationMode is not set", async () => {
      const { service } = makeService();
      await expect(
        service.provisionCotisationProduct(asso({ cotisationMode: null })),
      ).rejects.toThrow("cotisationMode is required");
    });
  });

  describe("granted-tag rollover (dated mode)", () => {
    it("grants the freshly derived current-year tag, not the stored stale one", async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: "dated" }));
      const stale = product({
        type: "membership",
        grantedTagName: "cotisant:bde-2000-2001",
        tagExpiresAt: new Date("2001-08-31"),
      });

      const grant = await (service as any).resolveGrantTag(stale);
      expect(grant.tagName).toMatch(/^cotisant:bde-\d{4}-\d{4}$/);
      expect(grant.tagName).not.toBe("cotisant:bde-2000-2001");
      expect(grant.expiresAt).toBeInstanceOf(Date);
    });

    it("falls back to the stored tag for a membership product without a cotisation mode", async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: null }));
      const legacy = product({
        type: "membership",
        grantedTagName: "cotisant:legacy",
        tagExpiresAt: null,
      });

      const grant = await (service as any).resolveGrantTag(legacy);
      expect(grant.tagName).toBe("cotisant:legacy");
      expect(grant.expiresAt).toBeNull();
    });

    it("returns null for a non-membership product", async () => {
      const { service } = makeService();
      const grant = await (service as any).resolveGrantTag(product({ type: "other" }));
      expect(grant).toBeNull();
    });
  });

  describe("Cercle balance_topup re-gating", () => {
    it("rejects creating a balance_topup product for a non-global-admin", async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());

      await expect(
        service.create("asso1", { name: "Recharge", type: "balance_topup" }, false),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows a global admin to create a balance_topup product", async () => {
      const { service, productRepo, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());

      await service.create("asso1", { name: "Recharge", type: "balance_topup" }, true);
      expect(productRepo.save).toHaveBeenCalled();
    });

    it("rejects updating an existing balance_topup product for a non-global-admin", async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product({ type: "balance_topup" }));

      await expect(service.update("asso1", "prod1", { name: "New name" }, false)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("allows a global admin to update an existing balance_topup product", async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product({ type: "balance_topup" }));

      await service.update("asso1", "prod1", { name: "New name" }, true);
      expect(productRepo.save).toHaveBeenCalled();
    });

    it("does not require global admin for non-balance_topup product updates", async () => {
      const { service, productRepo } = makeService();
      productRepo.findOne.mockResolvedValue(product({ type: "other" }));

      await expect(
        service.update("asso1", "prod1", { name: "New name" }, false),
      ).resolves.toBeDefined();
    });
  });

  describe("multi-tier upgrade pricing via memberPriceTag (WP-COT-2)", () => {
    it("applies the member price when the buyer holds the named memberPriceTag, even without the generic tag", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "cercle" }));
      productRepo.findOne.mockResolvedValue(
        product({ amountCentsMember: 300, memberPriceTag: "cotisant:cercle-sans-alcool" }),
      );
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === "cotisant:cercle-sans-alcool"),
      );

      const result = await (service as any).resolvePurchase("asso1", "prod1", "user1");
      expect(result.amountCents).toBe(300);
      expect(userTagService.hasActiveTag).toHaveBeenCalledWith(
        "user1",
        "cotisant:cercle-sans-alcool",
      );
    });

    it("does not fall back to the generic cotisant tag when memberPriceTag is set but not held", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "cercle" }));
      productRepo.findOne.mockResolvedValue(
        product({ amountCentsMember: 300, memberPriceTag: "cotisant:cercle-sans-alcool" }),
      );
      // Buyer holds the generic asso tag, but not the specific sibling-tier tag required here.
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === "cotisant:cercle"),
      );

      const result = await (service as any).resolvePurchase("asso1", "prod1", "user1");
      expect(result.amountCents).toBe(1000);
    });
  });

  describe("tier-specific grant tag (WP-COT-2)", () => {
    it("suffixes the granted tag with the product variantKey", async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "cercle", cotisationMode: "lifetime" }));
      const tiered = product({
        type: "membership",
        grantedTagName: "cotisant:cercle-avec-alcool",
        variantKey: "avec-alcool",
      });

      const grant = await (service as any).resolveGrantTag(tiered);
      expect(grant.tagName).toBe("cotisant:cercle-avec-alcool");
    });
  });

  describe("assertCanPurchase: same-tier rebuy blocked / sibling switch allowed (WP-COT-2)", () => {
    it("blocks re-buying the same tier while its tag is still active", async () => {
      const { service, assoRepo, purchaseRecordService, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "cercle", cotisationMode: "lifetime" }));
      purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(1);
      userTagService.hasActiveTag.mockResolvedValue(true);
      const avecAlcool = product({
        type: "membership",
        grantedTagName: "cotisant:cercle-avec-alcool",
        variantKey: "avec-alcool",
      });

      await expect((service as any).assertCanPurchase(avecAlcool, "user1", true)).rejects.toThrow(
        "You have already purchased this product",
      );
    });

    it("allows buying the sibling tier product even after purchasing another tier", async () => {
      const { service, purchaseRecordService } = makeService();
      // Purchase history is tracked per-product, so the buyer's prior "avec-alcool" purchase
      // does not count against a first purchase of the sibling "sans-alcool" product.
      purchaseRecordService.countPaidByUserAndProduct.mockResolvedValue(0);
      const sansAlcool = product({
        type: "membership",
        grantedTagName: "cotisant:cercle-sans-alcool",
        variantKey: "sans-alcool",
      });

      await expect(
        (service as any).assertCanPurchase(sansAlcool, "user1", true),
      ).resolves.toBeUndefined();
    });
  });

  describe("XOR sibling-tier revoke on fulfillment (WP-COT-2)", () => {
    it("grants the new tier tag and revokes the sibling tier tag in the same transaction", async () => {
      const { service, assoRepo, userTagService, manager } = makeService();
      const cercle = asso({ slug: "cercle", cotisationMode: "lifetime" });
      assoRepo.findOne.mockResolvedValue(cercle);
      manager.findOne.mockResolvedValue(cercle);
      const avecAlcool = product({
        id: "prod-avec",
        type: "membership",
        grantedTagName: "cotisant:cercle-avec-alcool",
        variantKey: "avec-alcool",
      });
      const sansAlcool = product({
        id: "prod-sans",
        type: "membership",
        grantedTagName: "cotisant:cercle-sans-alcool",
        variantKey: "sans-alcool",
      });
      manager.find.mockResolvedValue([avecAlcool, sansAlcool]);

      await (service as any).fulfillProductPurchase({
        product: avecAlcool,
        userId: "user1",
        amountCents: 1000,
        paymentMethod: "cash",
        stripePaymentIntentId: null,
        grantedBy: "admin1",
        dispatchWebhook: false,
      });

      expect(userTagService.grantOrRenew).toHaveBeenCalledWith(
        expect.objectContaining({ tagName: "cotisant:cercle-avec-alcool" }),
        manager,
      );
      expect(userTagService.revokeByName).toHaveBeenCalledWith(
        "user1",
        "cotisant:cercle-sans-alcool",
        manager,
      );
    });

    it("does not attempt a sibling revoke for a single-tier (no variantKey) product", async () => {
      const { service, assoRepo, userTagService, manager } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "bde", cotisationMode: "lifetime" }));
      const single = product({ type: "membership", grantedTagName: "cotisant:bde" });

      await (service as any).fulfillProductPurchase({
        product: single,
        userId: "user1",
        amountCents: 1000,
        paymentMethod: "cash",
        stripePaymentIntentId: null,
        grantedBy: "admin1",
        dispatchWebhook: false,
      });

      expect(userTagService.revokeByName).not.toHaveBeenCalled();
      expect(manager.find).not.toHaveBeenCalled();
    });
  });

  describe("requiredTags gating (WP-COT-3)", () => {
    it("rejects a purchase when requiredTags is set and the buyer holds none of them", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(product({ requiredTags: ["tag:a", "tag:b"] }));
      userTagService.hasActiveTag.mockResolvedValue(false);

      await expect((service as any).resolvePurchase("asso1", "prod1", "user1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("allows a purchase when the buyer holds ANY of the requiredTags", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(product({ requiredTags: ["tag:a", "tag:b"] }));
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === "tag:b"),
      );

      const result = await (service as any).resolvePurchase("asso1", "prod1", "user1");
      expect(result.amountCents).toBe(1000);
    });

    it("takes precedence over membersOnly: a non-cotisant holding a required tag can still buy", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso());
      productRepo.findOne.mockResolvedValue(
        product({ membersOnly: true, requiredTags: ["tag:vip"] }),
      );
      // Buyer holds neither the association's base cotisant tag nor any tier - only tag:vip.
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === "tag:vip"),
      );

      const result = await (service as any).resolvePurchase("asso1", "prod1", "user1");
      expect(result.amountCents).toBe(1000);
    });
  });

  describe("membersOnly any-tier back-compat (WP-COT-3)", () => {
    it("allows a members-only purchase when the buyer holds a sibling tier tag, not the base tag", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "cercle", cotisationMode: "lifetime" }));
      const avecAlcool = product({
        id: "prod-avec",
        type: "membership",
        variantKey: "avec-alcool",
      });
      const sansAlcool = product({
        id: "prod-sans",
        type: "membership",
        variantKey: "sans-alcool",
      });
      const goodies = product({ id: "prod-goodies", membersOnly: true });
      // isBuyerCotisant enumerates the association's tiered membership products.
      productRepo.find.mockResolvedValue([avecAlcool, sansAlcool]);
      productRepo.findOne.mockResolvedValue(goodies);
      userTagService.hasActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === "cotisant:cercle-sans-alcool"),
      );

      const result = await (service as any).resolvePurchase("asso1", "prod-goodies", "user1");
      expect(result.amountCents).toBe(1000);
    });

    it("rejects a members-only purchase when the buyer holds none of the association tiers", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "cercle", cotisationMode: "lifetime" }));
      const avecAlcool = product({
        id: "prod-avec",
        type: "membership",
        variantKey: "avec-alcool",
      });
      const sansAlcool = product({
        id: "prod-sans",
        type: "membership",
        variantKey: "sans-alcool",
      });
      const goodies = product({ id: "prod-goodies", membersOnly: true });
      productRepo.find.mockResolvedValue([avecAlcool, sansAlcool]);
      productRepo.findOne.mockResolvedValue(goodies);
      userTagService.hasActiveTag.mockResolvedValue(false);

      await expect(
        (service as any).resolvePurchase("asso1", "prod-goodies", "user1"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listAllActive viewerIsCotisant/viewerActiveTier (WP-COT-3)", () => {
    it("annotates products with the viewer's active tier across a multi-tier association", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const cercle = asso({ id: "asso1", slug: "cercle", cotisationMode: "lifetime" });
      const avecAlcool = product({
        id: "prod-avec",
        associationId: "asso1",
        type: "membership",
        variantKey: "avec-alcool",
      });
      const sansAlcool = product({
        id: "prod-sans",
        associationId: "asso1",
        type: "membership",
        variantKey: "sans-alcool",
      });
      productRepo.find
        .mockResolvedValueOnce([avecAlcool, sansAlcool]) // listAllActive's own products query
        .mockResolvedValueOnce([avecAlcool, sansAlcool]); // cotisantStatusFor's tier query
      assoRepo.find.mockResolvedValue([cercle]);
      userTagService.listByUser.mockResolvedValue([{ tagName: "cotisant:cercle-sans-alcool" }]);

      const result = await service.listAllActive("user1");

      const sans = result.find((p) => p.id === "prod-sans")!;
      const avec = result.find((p) => p.id === "prod-avec")!;
      expect(sans.viewerIsCotisant).toBe(true);
      expect(sans.viewerActiveTier).toBe("sans-alcool");
      // Both products of the same association share the viewer's association-level status.
      expect(avec.viewerIsCotisant).toBe(true);
      expect(avec.viewerActiveTier).toBe("sans-alcool");
    });

    it("returns viewerIsCotisant=false and viewerActiveTier=null when the viewer holds no tag", async () => {
      const { service, productRepo, assoRepo, userTagService } = makeService();
      const bde = asso({ id: "asso1", slug: "bde", cotisationMode: "lifetime" });
      const membership = product({ id: "prod1", associationId: "asso1", type: "membership" });
      productRepo.find.mockResolvedValueOnce([membership]).mockResolvedValueOnce([membership]);
      assoRepo.find.mockResolvedValue([bde]);
      userTagService.listByUser.mockResolvedValue([]);

      const [result] = await service.listAllActive("user1");
      expect(result.viewerIsCotisant).toBe(false);
      expect(result.viewerActiveTier).toBeNull();
    });
  });

  describe("getCotisantStatusBySlug (WP-COT-4, inbound Cercle check)", () => {
    it("throws NotFoundException for an unknown slug", async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(null);

      await expect(service.getCotisantStatusBySlug("missing", "user1")).rejects.toThrow(
        "Association not found",
      );
    });

    it("returns isCotisant=false when the association has no cotisation mode", async () => {
      const { service, assoRepo } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ cotisationMode: null }));

      const status = await service.getCotisantStatusBySlug("bde", "user1");
      expect(status).toEqual({ isCotisant: false, tier: null, expiresAt: null });
    });

    it("returns isCotisant=false when the user holds no active tier tag", async () => {
      const { service, assoRepo, productRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "bde", cotisationMode: "lifetime" }));
      productRepo.find.mockResolvedValue([]);
      userTagService.getActiveTag.mockResolvedValue(null);

      const status = await service.getCotisantStatusBySlug("bde", "user1");
      expect(status).toEqual({ isCotisant: false, tier: null, expiresAt: null });
    });

    it("returns the held tier and its expiry for a multi-tier association", async () => {
      const { service, assoRepo, productRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "cercle", cotisationMode: "lifetime" }));
      productRepo.find.mockResolvedValue([
        { variantKey: "avec-alcool" },
        { variantKey: "sans-alcool" },
      ]);
      const expiresAt = new Date("2999-01-01T00:00:00Z");
      userTagService.getActiveTag.mockImplementation((_userId: string, tagName: string) =>
        Promise.resolve(tagName === "cotisant:cercle-sans-alcool" ? { expiresAt } : null),
      );

      const status = await service.getCotisantStatusBySlug("cercle", "user1");
      expect(status).toEqual({
        isCotisant: true,
        tier: "sans-alcool",
        expiresAt: expiresAt.toISOString(),
      });
    });

    it("returns a null expiresAt for a lifetime single-tier tag", async () => {
      const { service, assoRepo, productRepo, userTagService } = makeService();
      assoRepo.findOne.mockResolvedValue(asso({ slug: "bde", cotisationMode: "lifetime" }));
      productRepo.find.mockResolvedValue([]);
      userTagService.getActiveTag.mockResolvedValue({ expiresAt: null });

      const status = await service.getCotisantStatusBySlug("bde", "user1");
      expect(status).toEqual({ isCotisant: true, tier: null, expiresAt: null });
    });
  });
});
