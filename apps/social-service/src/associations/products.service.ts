import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, IsNull, Not, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { firstValueFrom } from "rxjs";
import * as ExcelJS from "exceljs";
import { AssociationProduct } from "./entities/association-product.entity";
import { WebhookDelivery } from "./entities/webhook-delivery.entity";
import { Association } from "./entities/association.entity";
import { UserTagService } from "../users/user-tag.service";
import { PurchaseRecordService } from "../users/purchase-record.service";
import { PurchaseRecord } from "../users/entities/purchase-record.entity";
import { resolveStripeCallbackUrl } from "../common/stripe-callback-url";
import { CreateProductDto, GrantProductPurchaseDto, UpdateProductDto } from "./dto/association.dto";
import { deriveCotisationTag, tierVariantKeys } from "./cotisation-tag.util";
import { isDelegating, resolvePaymentTarget, type PaymentTarget } from "./payment-delegation.util";

/** Delays used between Cercle webhook delivery attempts (ms). */
const CERCLE_RETRY_DELAYS = [1_000, 5_000, 15_000];

/**
 * A shop product annotated with the requesting user's cotisation status for its association:
 * whether they hold ANY active tier tag (back-compat `membersOnly`/generic semantics), and which
 * specific tier (`variantKey`) they currently hold, if any (WP-COT-3). Lets the client gate/label
 * members-only products without mirroring the cotisation-tag derivation client-side (both flags
 * are computed authoritatively server-side).
 */
export type ShopProduct = AssociationProduct & {
  viewerIsCotisant: boolean;
  viewerActiveTier: string | null;
};

/** Boutique CRUD, Stripe Checkout creation, and Cercle webhook dispatch for association products. */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(AssociationProduct)
    private readonly productRepo: Repository<AssociationProduct>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveryRepo: Repository<WebhookDelivery>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly userTagService: UserTagService,
    private readonly purchaseRecordService: PurchaseRecordService,
  ) {}

  /**
   * Resolves the Stripe target for an association, following an approved parent-payment delegation
   * to the parent's account. Loads the parent only when the association actually delegates.
   */
  private async resolvePaymentTargetFor(asso: Association): Promise<PaymentTarget> {
    const parent = isDelegating(asso)
      ? await this.assoRepo.findOne({ where: { id: asso.paymentParentAssociationId } })
      : null;
    return resolvePaymentTarget(asso, parent);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Returns all active products across all associations (login required, listed on /shop), each
   * annotated with `viewerIsCotisant`/`viewerActiveTier` for `userId` so the client can gate/label
   * members-only products without mirroring the cotisation-tag derivation.
   */
  async listAllActive(userId: string): Promise<ShopProduct[]> {
    const products = await this.productRepo.find({
      where: { isActive: true },
      order: { associationId: "ASC", sortOrder: "ASC", createdAt: "ASC" },
    });
    const statusByAssoc = await this.cotisantStatusFor(userId, [
      ...new Set(products.map((p) => p.associationId)),
    ]);
    return products.map((p) => {
      const status = statusByAssoc.get(p.associationId);
      return {
        ...p,
        viewerIsCotisant: status?.isCotisant ?? false,
        viewerActiveTier: status?.activeTier ?? null,
      };
    });
  }

  /**
   * Given a user and a set of association ids, returns per-association cotisation status: whether
   * the user holds ANY active tier tag for it (`isCotisant`, back-compat `membersOnly`/generic
   * semantics - see `isBuyerCotisant`), and which specific tier (`variantKey`) they currently hold,
   * if any (`activeTier`, WP-COT-3). Loads each association's tiered products and the user's active
   * tags once, so annotating N products costs a fixed number of queries regardless of product count.
   */
  private async cotisantStatusFor(
    userId: string,
    assocIds: string[],
  ): Promise<Map<string, { isCotisant: boolean; activeTier: string | null }>> {
    const result = new Map<string, { isCotisant: boolean; activeTier: string | null }>();
    if (assocIds.length === 0) return result;
    const [assos, tierProducts, activeTags] = await Promise.all([
      this.assoRepo.find({
        where: { id: In(assocIds) },
        select: { id: true, slug: true, cotisationMode: true },
      }),
      this.productRepo.find({
        where: { associationId: In(assocIds), type: "membership", isActive: true },
        select: { associationId: true, variantKey: true },
      }),
      this.userTagService.listByUser(userId),
    ]);
    const activeTagNames = new Set(activeTags.map((t) => t.tagName));
    const tiersByAssoc = new Map<string, { variantKey: string | null }[]>();
    for (const p of tierProducts) {
      const list = tiersByAssoc.get(p.associationId) ?? [];
      list.push({ variantKey: p.variantKey });
      tiersByAssoc.set(p.associationId, list);
    }
    for (const asso of assos) {
      if (!asso.cotisationMode) continue;
      let isCotisant = false;
      let activeTier: string | null = null;
      for (const variantKey of tierVariantKeys(tiersByAssoc.get(asso.id) ?? [])) {
        const { tagName } = deriveCotisationTag(
          asso.slug,
          asso.cotisationMode,
          new Date(),
          variantKey,
        );
        if (activeTagNames.has(tagName)) {
          isCotisant = true;
          activeTier = variantKey;
          break;
        }
      }
      result.set(asso.id, { isCotisant, activeTier });
    }
    return result;
  }

  /** Returns active products for a single association ordered by sortOrder. */
  async listByAssoc(associationId: string): Promise<AssociationProduct[]> {
    return this.productRepo.find({
      where: { associationId, isActive: true },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
  }

  /** Returns all products for admin (including inactive), ordered by sortOrder. */
  async listAllByAssoc(associationId: string): Promise<AssociationProduct[]> {
    return this.productRepo.find({
      where: { associationId },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
  }

  /**
   * Creates a product for an association.
   * If Stripe Connect onboarding is incomplete the product is created but forced inactive.
   * `balance_topup` (Cercle) products require the caller to be a platform global admin,
   * even though the endpoint is otherwise reachable with `MANAGE_PRODUCTS` (D7).
   */
  async create(
    associationId: string,
    dto: CreateProductDto,
    isGlobalAdmin: boolean,
  ): Promise<AssociationProduct> {
    this.logger.debug(
      `[SHOP] create product: association=${associationId.slice(0, 8)} type=${dto.type} isGlobalAdmin=${isGlobalAdmin}`,
    );
    if (dto.type === "balance_topup" && !isGlobalAdmin) {
      this.logger.debug(
        `[CERCLE] rejected balance_topup creation by non-global-admin for association=${associationId.slice(0, 8)}`,
      );
      throw new ForbiddenException(
        "Only platform global admins may create Cercle balance_topup products",
      );
    }

    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException("Association not found");

    if (
      dto.customAmountMinCents !== undefined &&
      dto.customAmountMaxCents !== undefined &&
      dto.customAmountMinCents > dto.customAmountMaxCents
    ) {
      throw new BadRequestException("customAmountMinCents must be ≤ customAmountMaxCents");
    }

    const { webhookUrl, webhookSecret, ...rest } = dto;

    // Payments may be served by an approved parent's account (delegation), so gate on the
    // resolved target's readiness rather than this association's own onboarding flag.
    const paymentTarget = await this.resolvePaymentTargetFor(asso);
    const product = this.productRepo.create({
      ...rest,
      currency: "eur",
      associationId,
      webhookUrl: webhookUrl ?? null,
      webhookSecret: webhookSecret ?? null,
      // Product is inactive until payments can be taken (own or delegated Stripe account ready).
      isActive: paymentTarget.ready ? (dto.isActive ?? true) : false,
    });
    return this.productRepo.save(product);
  }

  /**
   * Updates mutable fields of a product. Ignores webhookSecret if not provided.
   * Updating an existing `balance_topup` (Cercle) product requires the caller to be a
   * platform global admin, even though the endpoint is otherwise reachable with
   * `MANAGE_PRODUCTS` (D7).
   */
  async update(
    associationId: string,
    productId: string,
    dto: UpdateProductDto,
    isGlobalAdmin: boolean,
  ): Promise<AssociationProduct> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException("Product not found");

    if (product.type === "balance_topup" && !isGlobalAdmin) {
      this.logger.debug(
        `[CERCLE] rejected balance_topup update by non-global-admin for product=${productId.slice(0, 8)}`,
      );
      throw new ForbiddenException(
        "Only platform global admins may modify Cercle balance_topup products",
      );
    }

    const minCents = dto.customAmountMinCents ?? product.customAmountMinCents;
    const maxCents = dto.customAmountMaxCents ?? product.customAmountMaxCents;
    if (
      minCents !== null &&
      maxCents !== null &&
      minCents !== undefined &&
      maxCents !== undefined &&
      minCents > maxCents
    ) {
      throw new BadRequestException("customAmountMinCents must be ≤ customAmountMaxCents");
    }

    Object.assign(product, dto, { currency: "eur" });
    return this.productRepo.save(product);
  }

  /** Removes a product from the association's boutique. */
  async delete(associationId: string, productId: string): Promise<void> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException("Product not found");
    await this.productRepo.remove(product);
  }

  // ── Cotisation config ─────────────────────────────────────────────────────

  /**
   * Upserts the single canonical `membership` product for an association whose cotisations
   * are enabled (D1): derives `grantedTagName`/`tagExpiresAt` from `deriveCotisationTag` so the
   * granted tag always matches the association's current slug/mode. Called after
   * `PATCH /associations/:id` when `cotisationEnabled` is true.
   *
   * The product's `name` (editable label) and `amountCents` (price) are preserved across calls
   * once set, so this never overwrites admin edits made through the regular product endpoints -
   * it only ever (re)synchronizes the derived tag fields.
   */
  async provisionCotisationProduct(asso: Association): Promise<AssociationProduct> {
    this.logger.debug(
      `[COTISATION] provisioning canonical product: association=${asso.id.slice(0, 8)} mode=${asso.cotisationMode}`,
    );
    if (!asso.cotisationMode) {
      throw new BadRequestException("cotisationMode is required when cotisationEnabled is true");
    }

    const { tagName, expiresAt } = deriveCotisationTag(asso.slug, asso.cotisationMode);

    let product = await this.productRepo.findOne({
      where: { associationId: asso.id, type: "membership" },
    });

    if (!product) {
      this.logger.log(
        `[COTISATION] creating canonical membership product for association=${asso.id.slice(0, 8)} tag=${tagName}`,
      );
      product = this.productRepo.create({
        associationId: asso.id,
        name: "Cotisation",
        currency: "eur",
        type: "membership",
        grantedTagName: tagName,
        tagExpiresAt: expiresAt,
        // Active once payments can be taken - own account or an approved parent's (delegation).
        isActive: (await this.resolvePaymentTargetFor(asso)).ready,
      });
    } else {
      this.logger.log(
        `[COTISATION] updating canonical membership product tag for association=${asso.id.slice(0, 8)} tag=${tagName}`,
      );
      product.grantedTagName = tagName;
      product.tagExpiresAt = expiresAt;
    }

    return this.productRepo.save(product);
  }

  // ── Stripe Checkout ───────────────────────────────────────────────────────

  /**
   * Creates a Stripe Checkout session for purchasing a product.
   * The association must have completed Stripe Connect onboarding.
   */
  async createCheckoutSession(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number,
    callbackUrls?: { successUrl?: string; cancelUrl?: string },
  ): Promise<{ checkoutUrl: string; amountCents: number; currency: string }> {
    const { product, amountCents, paymentTarget } = await this.resolvePurchase(
      associationId,
      productId,
      userId,
      customAmountCents,
    );

    const paymentBase = (
      this.config.get<string>("PAYMENT_SERVICE_URL") ?? "http://core-service:3012"
    ).replace(/\/$/, "");
    const frontendUrl = this.config.get<string>("FRONTEND_URL") ?? "http://localhost";

    // Resolve the Stripe customer ID so the card gets saved after checkout
    let customerId: string | undefined;
    try {
      const resp = await firstValueFrom(
        this.httpService.post<{ customerId: string | null }>(
          `${paymentBase}/api/payments/internal/customer-id`,
          { userId },
          { maxRedirects: 0 },
        ),
      );
      customerId = resp.data.customerId ?? undefined;
    } catch {
      this.logger.warn(`Could not resolve Stripe customerId for user ${userId}`);
    }

    const successUrl = resolveStripeCallbackUrl(
      callbackUrls?.successUrl,
      `${frontendUrl}/shop?purchase_success=1&productId=${product.id}`,
      frontendUrl,
    );
    const cancelUrl = resolveStripeCallbackUrl(
      callbackUrls?.cancelUrl,
      `${frontendUrl}/shop?purchase_cancel=1`,
      frontendUrl,
    );

    const resp = await firstValueFrom(
      this.httpService.post<{ ok: boolean; url: string; id: string }>(
        `${paymentBase}/api/payments/create-checkout-session`,
        {
          lineItems: [
            {
              price_data: {
                currency: product.currency,
                product_data: { name: product.name },
                unit_amount: amountCents,
              },
              quantity: 1,
            },
          ],
          successUrl,
          cancelUrl,
          metadata: { productId: product.id, userId },
          stripeConnectAccountId: paymentTarget.stripeAccountId,
          customerId,
        },
        { maxRedirects: 0 },
      ),
    );

    if (!resp.data?.url) {
      throw new BadRequestException("Payment service did not return a checkout URL");
    }

    this.logger.log(
      `[SHOP] Checkout session created: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)}`,
    );
    return { checkoutUrl: resp.data.url, amountCents, currency: product.currency };
  }

  /**
   * Returns charge details for a saved-card PaymentIntent (core-service charge-product-saved-method).
   * Re-validates purchase limits at charge time.
   */
  async getChargeContext(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number,
  ): Promise<{
    productId: string;
    userId: string;
    amountCents: number;
    currency: string;
    stripeAccountId: string;
  }> {
    const { product, amountCents, paymentTarget } = await this.resolvePurchase(
      associationId,
      productId,
      userId,
      customAmountCents,
    );
    this.logger.debug(
      `[SHOP] charge context: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)} amount=${amountCents}`,
    );
    return {
      productId: product.id,
      userId,
      amountCents,
      currency: product.currency,
      // resolvePurchase guarantees paymentTarget.ready + non-null stripeAccountId.
      stripeAccountId: paymentTarget.stripeAccountId,
    };
  }

  /** Loads product/association, validates purchase rules, and resolves the amount in cents. */
  private async resolvePurchase(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number,
  ): Promise<{
    asso: Association;
    product: AssociationProduct;
    amountCents: number;
    paymentTarget: PaymentTarget;
  }> {
    const [asso, product] = await Promise.all([
      this.assoRepo.findOne({ where: { id: associationId } }),
      this.productRepo.findOne({ where: { id: productId, associationId } }),
    ]);

    if (!asso) throw new NotFoundException("Association not found");
    if (!product || !product.isActive) throw new NotFoundException("Product not found or inactive");

    // Route to the association's own account, or an approved parent's when delegating.
    const paymentTarget = await this.resolvePaymentTargetFor(asso);
    if (!paymentTarget.ready || !paymentTarget.stripeAccountId) {
      throw new BadRequestException(
        paymentTarget.delegated
          ? "The parent association this club delegates payments to has not completed Stripe Connect onboarding"
          : "Association has not completed Stripe Connect onboarding",
      );
    }

    const isCotisant = await this.isBuyerCotisant(asso, userId);
    await this.assertCanPurchase(product, userId, isCotisant);

    let amountCents: number;
    if (product.amountCents !== null) {
      const qualifiesForMemberPrice = product.memberPriceTag
        ? await this.userTagService.hasActiveTag(userId, product.memberPriceTag)
        : isCotisant;
      if (qualifiesForMemberPrice && product.amountCentsMember != null) {
        amountCents = product.amountCentsMember;
        this.logger.debug(
          `[SHOP] member price applied: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} amount=${amountCents}`,
        );
      } else {
        amountCents = product.amountCents;
      }
    } else if (product.allowCustomAmount && customAmountCents !== undefined) {
      const min = product.customAmountMinCents ?? 0;
      const max = product.customAmountMaxCents ?? Infinity;
      if (customAmountCents < min || customAmountCents > max) {
        throw new BadRequestException(`Custom amount must be between ${min} and ${max} cents`);
      }
      amountCents = customAmountCents;
    } else {
      throw new BadRequestException("No amount provided for this product");
    }

    return { asso, product, amountCents, paymentTarget };
  }

  /**
   * Lists all completed purchases for an association (boutique + paid forms).
   * Requires MANAGE_PRODUCTS on the association (enforced by controller).
   */
  async listAssociationPurchases(associationId: string): Promise<
    Array<{
      id: string;
      userId: string;
      source: "form" | "product";
      productId: string | null;
      formId: string | null;
      productName: string;
      amountCents: number;
      paymentMethod: "stripe" | "cash";
      paidAt: string;
      firstName: string | null;
      lastName: string | null;
    }>
  > {
    const records = await this.purchaseRecordService.listPaidByAssociation(associationId);
    return this.enrichPurchaseRecords(records);
  }

  /**
   * Builds an XLSX export of an association's completed purchases (boutique + paid forms), the
   * same rows as `listAssociationPurchases`. Used by the association's own accounting view and by
   * an approved parent's delegated-accounting view. Columns match the treasurer-facing table.
   */
  async exportAssociationPurchases(
    associationId: string,
  ): Promise<{ buffer: Buffer; title: string }> {
    this.logger.debug(`[SHOP] exportAssociationPurchases assoc=${associationId.slice(0, 8)}`);
    const nameRows: { name: string }[] = await this.productRepo.manager.query(
      `SELECT name FROM associations WHERE id = $1`,
      [associationId],
    );
    const assocName = nameRows[0]?.name ?? "achats";
    const purchases = await this.listAssociationPurchases(associationId);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Achats");
    sheet.columns = [
      { header: "Nom", key: "lastName", width: 20 },
      { header: "Prénom", key: "firstName", width: 20 },
      { header: "Type", key: "source", width: 12 },
      { header: "Produit", key: "productName", width: 30 },
      { header: "Montant", key: "amount", width: 12, style: { numFmt: '0.00 "€"' } },
      { header: "Paiement", key: "paymentMethod", width: 12 },
      { header: "Date", key: "paidAt", width: 18, style: { numFmt: "dd/mm/yyyy hh:mm" } },
    ];

    purchases.forEach((p) => {
      sheet.addRow({
        lastName: p.lastName ?? "",
        firstName: p.firstName ?? "",
        source: p.source === "form" ? "Formulaire" : "Boutique",
        productName: p.productName,
        amount: p.amountCents / 100,
        paymentMethod: p.paymentMethod === "cash" ? "Espèces" : "Stripe",
        paidAt: new Date(p.paidAt),
      });
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, title: `achats_${assocName}` };
  }

  /**
   * Lists completed purchases for a boutique product with buyer display names.
   * Requires MANAGE_PRODUCTS on the association (enforced by controller).
   */
  async listProductPurchases(
    associationId: string,
    productId: string,
  ): Promise<
    Array<{
      id: string;
      userId: string;
      amountCents: number;
      paidAt: string;
      firstName: string | null;
      lastName: string | null;
    }>
  > {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException("Product not found");

    const records = await this.purchaseRecordService.listPaidByProduct(productId);
    return this.enrichPurchaseRecords(records);
  }

  /** Attaches buyer display names to purchase records. */
  private async enrichPurchaseRecords(records: PurchaseRecord[]): Promise<
    Array<{
      id: string;
      userId: string;
      source: "form" | "product";
      productId: string | null;
      formId: string | null;
      productName: string;
      amountCents: number;
      paymentMethod: "stripe" | "cash";
      paidAt: string;
      firstName: string | null;
      lastName: string | null;
    }>
  > {
    const userIds = [...new Set(records.map((r) => r.userId))];
    const nameMap = new Map<string, { firstName: string | null; lastName: string | null }>();
    if (userIds.length > 0) {
      const rows: { id: string; firstName: string | null; lastName: string | null }[] =
        await this.productRepo.manager.query(
          `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [userIds],
        );
      rows.forEach((r) => nameMap.set(r.id, { firstName: r.firstName, lastName: r.lastName }));
    }

    return records.map((r) => ({
      id: r.id,
      userId: r.userId,
      source: r.source,
      productId: r.productId,
      formId: r.formId,
      productName: r.productName,
      amountCents: r.amountCents,
      paymentMethod: r.paymentMethod,
      paidAt: r.paidAt.toISOString(),
      firstName: nameMap.get(r.userId)?.firstName ?? null,
      lastName: nameMap.get(r.userId)?.lastName ?? null,
    }));
  }

  /**
   * Returns true when the user holds ANY of the association's active tier tags (see
   * `deriveCotisationTag`/`tierVariantKeys`) - i.e. is a cotisant of at least one tier, regardless
   * of which. Kept deliberately generic (not tier-specific) so `membersOnly` gating and the Cercle
   * `balance_topup` recharge stay open to every forfait, per-tier gating being what `requiredTags`
   * is for. Always false when the association has no cotisation mode configured (`cotisationMode`
   * null), regardless of `cotisationEnabled`.
   */
  private async isBuyerCotisant(asso: Association, userId: string): Promise<boolean> {
    if (!asso.cotisationMode) return false;
    const tiers = await this.productRepo.find({
      where: { associationId: asso.id, type: "membership", isActive: true },
      select: { variantKey: true },
    });
    for (const variantKey of tierVariantKeys(tiers)) {
      const { tagName } = deriveCotisationTag(
        asso.slug,
        asso.cotisationMode,
        new Date(),
        variantKey,
      );
      if (await this.userTagService.hasActiveTag(userId, tagName)) return true;
    }
    return false;
  }

  /** Returns true when the user holds at least one of the given tag names. */
  private async hasAnyActiveTag(userId: string, tagNames: string[]): Promise<boolean> {
    for (const tagName of tagNames) {
      if (await this.userTagService.hasActiveTag(userId, tagName)) return true;
    }
    return false;
  }

  /** Enforces member-gating, per-user/global purchase limits, and membership renewal rules. */
  private async assertCanPurchase(
    product: AssociationProduct,
    userId: string,
    isCotisant: boolean,
  ): Promise<void> {
    const requiredTags = product.requiredTags ?? [];
    this.logger.debug(
      `[SHOP] assertCanPurchase: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} membersOnly=${product.membersOnly} requiredTags=${requiredTags.length} isCotisant=${isCotisant}`,
    );
    // requiredTags generalizes membersOnly (any listed tag, not just the asso's own cotisation
    // tiers) and takes precedence when set; membersOnly falls back to "any active tier tag of
    // the owning association" (isCotisant, back-compat).
    const gateFailed =
      requiredTags.length > 0
        ? !(await this.hasAnyActiveTag(userId, requiredTags))
        : product.membersOnly && !isCotisant;
    if (gateFailed) {
      this.logger.debug(
        `[SHOP] rejected: product=${product.id.slice(0, 8)} gating not satisfied for user=${userId.slice(0, 8)}`,
      );
      throw new ForbiddenException(
        requiredTags.length > 0
          ? "This product is reserved to users holding one of the required tags"
          : "This product is reserved to the association's cotisants",
      );
    }

    const paidCount = await this.purchaseRecordService.countPaidByUserAndProduct(
      userId,
      product.id,
    );

    if (product.maxPurchasesTotal != null) {
      const totalPaid = await this.purchaseRecordService.countPaidByProduct(product.id);
      if (totalPaid >= product.maxPurchasesTotal) {
        throw new BadRequestException("Ce produit est en rupture de stock");
      }
    }

    if (product.allowRepeatPurchase) {
      if (product.maxPurchasesPerUser != null && paidCount >= product.maxPurchasesPerUser) {
        throw new BadRequestException("Limite d'achats atteinte pour ce produit");
      }
      return;
    }

    if (paidCount === 0) return;

    if (product.type === "membership" && product.grantedTagName) {
      // Renewal: allow re-buying once the CURRENT tag has expired. Resolve the effective tag
      // (derived per academic year for cotisation-mode associations) rather than the stored one,
      // so the check stays correct across a yearly rollover.
      const grant = await this.resolveGrantTag(product);
      if (grant) {
        const hasTag = await this.userTagService.hasActiveTag(userId, grant.tagName);
        if (!hasTag) return;
      }
    }

    throw new BadRequestException("You have already purchased this product");
  }

  /**
   * Manually records a product purchase for a user (cash payment, retroactive grant).
   * Grants membership tags like a real purchase but does not dispatch Cercle webhooks.
   */
  async grantProductPurchase(
    associationId: string,
    productId: string,
    grantedBy: string,
    dto: GrantProductPurchaseDto,
  ): Promise<{
    id: string;
    userId: string;
    source: "form" | "product";
    productId: string | null;
    formId: string | null;
    productName: string;
    amountCents: number;
    paymentMethod: "stripe" | "cash";
    paidAt: string;
    firstName: string | null;
    lastName: string | null;
  }> {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException("Product not found");

    const userRows: { id: string }[] = await this.productRepo.manager.query(
      `SELECT id FROM users WHERE id = $1`,
      [dto.userId],
    );
    if (userRows.length === 0) throw new NotFoundException("User not found");

    let amountCents: number;
    if (dto.amountCents != null) {
      amountCents = dto.amountCents;
    } else if (product.amountCents != null) {
      amountCents = product.amountCents;
    } else {
      throw new BadRequestException("amountCents is required for this product");
    }

    if (product.allowCustomAmount && product.customAmountMinCents != null) {
      const min = product.customAmountMinCents;
      const max = product.customAmountMaxCents ?? Infinity;
      if (amountCents < min || amountCents > max) {
        throw new BadRequestException(`amountCents must be between ${min} and ${max}`);
      }
    }

    this.logger.log(
      `[SHOP] manual grant: product=${productId.slice(0, 8)} user=${dto.userId.slice(0, 8)} by=${grantedBy.slice(0, 8)}`,
    );

    const record = await this.fulfillProductPurchase({
      product,
      userId: dto.userId,
      amountCents,
      paymentMethod: "cash",
      stripePaymentIntentId: null,
      grantedBy,
      dispatchWebhook: false,
    });
    const [enriched] = await this.enrichPurchaseRecords([record]);
    return enriched;
  }

  // ── Post-purchase ─────────────────────────────────────────────────────────

  /**
   * Called by the Stripe webhook (via core-service) after a successful product purchase.
   * Grants membership tags, dispatches Cercle webhooks, and records the purchase.
   * Idempotent: skips processing if payment intent was already recorded.
   */
  async handlePurchaseCompleted(
    productId: string,
    userId: string,
    amountCents: number,
    paymentIntentId: string,
  ): Promise<void> {
    const existing = await this.purchaseRecordService.findByPaymentIntent(paymentIntentId);
    if (existing) {
      this.logger.log(`[SHOP] purchase ${paymentIntentId} already processed - skipping`);
      return;
    }

    const product = await this.productRepo.findOne({ where: { id: productId } });
    if (!product) {
      this.logger.error(`[SHOP] product ${productId} not found for purchase ${paymentIntentId}`);
      return;
    }

    await this.fulfillProductPurchase({
      product,
      userId,
      amountCents,
      paymentMethod: "stripe",
      stripePaymentIntentId: paymentIntentId,
      grantedBy: "system",
      dispatchWebhook: true,
    });

    this.logger.log(
      `[SHOP] purchase completed: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)}`,
    );
  }

  /**
   * Resolves the tag name and expiry to grant for a product purchase.
   * Returns null for non-membership products or membership products with no tag configured.
   * For an association with an active cotisation mode, the tag is derived fresh from the current
   * academic year and the product's `variantKey` (see `deriveCotisationTag`), so a purchase always
   * grants the current period's tier-specific tag even when the stored product tag has not been
   * re-provisioned since the last yearly rollover. Falls back to the product's stored tag for
   * membership products without a cotisation mode (arbitrary/legacy tags).
   */
  private async resolveGrantTag(
    product: AssociationProduct,
  ): Promise<{ tagName: string; expiresAt: Date | null } | null> {
    if (product.type !== "membership" || !product.grantedTagName) return null;
    const asso = await this.assoRepo.findOne({ where: { id: product.associationId } });
    if (asso?.cotisationMode) {
      return deriveCotisationTag(asso.slug, asso.cotisationMode, new Date(), product.variantKey);
    }
    return { tagName: product.grantedTagName, expiresAt: product.tagExpiresAt ?? null };
  }

  /**
   * XOR enforcement for multi-tier cotisations: when a purchased product carries a `variantKey`,
   * revokes the buyer's tag(s) for the association's OTHER tiers (e.g. buying "avec-alcool"
   * revokes an existing "sans-alcool" tag), so a cotisant holds exactly one tier at a time. A
   * no-op for single-tier products (`variantKey` null) or associations without a cotisation mode.
   * Runs inside the same transaction as the grant so a switch is atomic.
   */
  private async revokeSiblingTierTags(
    manager: EntityManager,
    product: AssociationProduct,
    userId: string,
  ): Promise<void> {
    if (!product.variantKey) return;
    const asso = await manager.findOne(Association, { where: { id: product.associationId } });
    if (!asso?.cotisationMode) return;

    const siblings = await manager.find(AssociationProduct, {
      where: {
        associationId: product.associationId,
        type: "membership",
        variantKey: Not(IsNull()),
      },
    });
    for (const sibling of siblings) {
      if (sibling.variantKey === product.variantKey) continue;
      const siblingTag = deriveCotisationTag(
        asso.slug,
        asso.cotisationMode,
        new Date(),
        sibling.variantKey,
      );
      await this.userTagService.revokeByName(userId, siblingTag.tagName, manager);
    }
  }

  /** Grants tags, optionally dispatches webhooks, and persists the purchase record. */
  private async fulfillProductPurchase(params: {
    product: AssociationProduct;
    userId: string;
    amountCents: number;
    paymentMethod: "stripe" | "cash";
    stripePaymentIntentId: string | null;
    grantedBy: string;
    dispatchWebhook: boolean;
  }): Promise<PurchaseRecord> {
    const {
      product,
      userId,
      amountCents,
      paymentMethod,
      stripePaymentIntentId,
      grantedBy,
      dispatchWebhook,
    } = params;

    const grant = await this.resolveGrantTag(product);
    if (grant) {
      await this.productRepo.manager.transaction(async (manager) => {
        await this.userTagService.grantOrRenew(
          {
            userId,
            tagName: grant.tagName,
            issuingAssocId: product.associationId,
            grantedBy,
            expiresAt: grant.expiresAt,
            metadata: {
              productId: product.id,
              paymentIntentId: stripePaymentIntentId,
              manualGrant: paymentMethod === "cash",
            },
          },
          manager,
        );
        this.logger.log(`[SHOP] tag "${grant.tagName}" granted to user=${userId.slice(0, 8)}`);
        await this.revokeSiblingTierTags(manager, product, userId);
      });
    }

    if (
      dispatchWebhook &&
      product.type === "balance_topup" &&
      product.webhookUrl &&
      product.webhookSecret &&
      stripePaymentIntentId
    ) {
      await this.dispatchCercleWebhook(product, userId, amountCents, stripePaymentIntentId);
    }

    return this.purchaseRecordService.create({
      userId,
      source: "product",
      productId: product.id,
      amountCents,
      paymentMethod,
      status: "paid",
      stripePaymentIntentId,
      associationId: product.associationId,
      productName: product.name,
    });
  }

  // ── Cercle webhook ────────────────────────────────────────────────────────

  /**
   * Dispatches a signed Cercle balance_topup webhook with up to 3 delivery attempts.
   * Records each attempt in `webhook_deliveries` for admin visibility and manual retry.
   */
  async dispatchCercleWebhook(
    product: AssociationProduct,
    userId: string,
    amountCents: number,
    paymentIntentId: string,
  ): Promise<void> {
    const delivery = await this.deliveryRepo.save(
      this.deliveryRepo.create({
        productId: product.id,
        userId,
        amountCents,
        paymentIntentId,
        status: "pending",
      }),
    );

    const payload = JSON.stringify({
      productId: product.id,
      userId,
      amountCents,
      paymentIntentId,
      timestamp: new Date().toISOString(),
    });

    const signature = createHmac("sha256", product.webhookSecret).update(payload).digest("hex");

    let lastError = "";
    for (let i = 0; i < CERCLE_RETRY_DELAYS.length; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, CERCLE_RETRY_DELAYS[i]));
      }
      delivery.attemptCount = i + 1;
      delivery.lastAttemptAt = new Date();

      try {
        await firstValueFrom(
          this.httpService.post(product.webhookUrl, payload, {
            headers: {
              "Content-Type": "application/json",
              "X-Canari-Signature": `sha256=${signature}`,
            },
            timeout: 10_000,
            maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 300,
          }),
        );

        delivery.status = "delivered";
        delivery.lastError = null;
        await this.deliveryRepo.save(delivery);
        this.logger.log(
          `[CERCLE] webhook delivered: product=${product.id.slice(0, 8)} attempt=${i + 1}`,
        );
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : "[unknown error]";
        this.logger.warn(`[CERCLE] webhook attempt ${i + 1} failed: ${lastError}`);
      }
    }

    delivery.status = "failed";
    delivery.lastError = lastError;
    await this.deliveryRepo.save(delivery);
    this.logger.error(
      `[CERCLE] all ${CERCLE_RETRY_DELAYS.length} attempts failed for product=${product.id.slice(0, 8)}`,
    );
  }

  // ── Webhook delivery admin ────────────────────────────────────────────────

  /** Lists all failed Cercle webhook deliveries for an association's products. */
  async listWebhookFailures(associationId: string): Promise<WebhookDelivery[]> {
    const productIds = await this.productRepo
      .find({ where: { associationId }, select: { id: true } })
      .then((ps) => ps.map((p) => p.id));

    if (productIds.length === 0) return [];

    return this.deliveryRepo
      .createQueryBuilder("d")
      .where("d.productId IN (:...ids)", { ids: productIds })
      .andWhere("d.status = 'failed'")
      .orderBy("d.createdAt", "DESC")
      .getMany();
  }

  /** Retries a failed webhook delivery once. */
  async retryWebhookDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException("Webhook delivery not found");

    const product = await this.productRepo.findOne({ where: { id: delivery.productId } });
    if (!product || !product.webhookUrl || !product.webhookSecret) {
      throw new BadRequestException("Product webhook not configured");
    }

    await this.dispatchCercleWebhook(
      product,
      delivery.userId,
      delivery.amountCents,
      delivery.paymentIntentId,
    );
  }
}
