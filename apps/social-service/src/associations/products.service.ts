import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import { firstValueFrom } from 'rxjs';
import * as ExcelJS from 'exceljs';
import { AssociationProduct } from './entities/association-product.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { Association } from './entities/association.entity';
import { UserTagService } from '../users/user-tag.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { resolveStripeCallbackUrl } from '../common/stripe-callback-url';
import { CreateProductDto, GrantProductPurchaseDto, UpdateProductDto } from './dto/association.dto';
import { deriveCotisationTag, tierVariantKeys } from './cotisation-tag.util';
import {
  isDelegating,
  resolvePaymentTarget,
  fetchActivePaymentProvider,
  type PaymentTarget,
} from './payment-delegation.util';

/** Delays used between Cercle webhook delivery attempts (ms). The first one is not waited. */
const CERCLE_RETRY_DELAYS = [1_000, 5_000, 15_000];

/**
 * Backoff before each AUTOMATIC retry of a failed delivery (ms), indexed by `autoRetryCount`.
 *
 * Once this list runs out the row stops being picked up and stays in the admin failure list: a
 * delivery still failing a day later is not a transient outage, it is a configuration problem, and
 * retrying it forever would only hide that.
 */
const CERCLE_AUTO_RETRY_BACKOFF = [
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  24 * 3_600_000,
];

/** How many due deliveries one scheduler tick takes, so a backlog cannot stall the service. */
const CERCLE_AUTO_RETRY_BATCH = 20;

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

/**
 * A product as returned to a client: the Cercle HMAC key is replaced by a boolean saying whether
 * one is set. The admin page needs to know that a webhook is configured; nobody outside this
 * service needs the key itself.
 */
export type SafeProduct = AssociationProduct & { webhookConfigured: boolean };

/**
 * A failed Cercle delivery as the admin dashboard sees it: the row, plus who and what it is about.
 *
 * Dates are ISO strings rather than `Date`, so the shape is the same on both sides of the wire.
 */
export interface FailedDelivery {
  id: string;
  productId: string;
  productName: string | null;
  userId: string;
  firstName: string | null;
  lastName: string | null;
  amountCents: number;
  paymentIntentId: string;
  status: 'pending' | 'delivered' | 'failed';
  /** Total sends, across the initial dispatch and every retry since. */
  attemptCount: number;
  /** How many automatic retries have run, which is what picks the next backoff step. */
  autoRetryCount: number;
  lastAttemptAt: string | null;
  /** Null once the automatic ladder is exhausted: this one needs a human. */
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
}

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
    private readonly purchaseRecordService: PurchaseRecordService
  ) {}

  /**
   * Strips the Cercle HMAC key from a product before it leaves the service. `webhookSecret` is
   * shared with the Cercle alone - the signature it produces is worth nothing once a JSON response
   * carries the key, and `/products/all` answers every logged-in user. `webhookUrl` stays: it is a
   * public endpoint, and the admin page has to show what is configured.
   */
  private toSafeProduct<T extends AssociationProduct>(
    product: T
  ): T & { webhookConfigured: boolean } {
    return { ...product, webhookSecret: null, webhookConfigured: !!product.webhookSecret };
  }

  /** Base URL for calls to core-service (payments), same fallback used by createCheckoutSession below. */
  private get paymentBase(): string {
    return (this.config.get<string>('PAYMENT_SERVICE_URL') ?? 'http://core-service:3012').replace(
      /\/+$/,
      ''
    );
  }

  /**
   * Resolves the payment target for an association, following an approved parent-payment
   * delegation to the parent's account, against the platform's currently active provider
   * (Stripe/Lydia keep independent account ids). Loads the parent only when the association
   * actually delegates.
   */
  private async resolvePaymentTargetFor(asso: Association): Promise<PaymentTarget> {
    const [provider, parent] = await Promise.all([
      fetchActivePaymentProvider(this.httpService, this.paymentBase),
      isDelegating(asso)
        ? this.assoRepo.findOne({ where: { id: asso.paymentParentAssociationId } })
        : Promise.resolve(null),
    ]);
    return resolvePaymentTarget(asso, parent, provider);
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
      order: { associationId: 'ASC', sortOrder: 'ASC', createdAt: 'ASC' },
    });
    const statusByAssoc = await this.cotisantStatusFor(userId, [
      ...new Set(products.map((p) => p.associationId)),
    ]);
    return products.map((p) => {
      const status = statusByAssoc.get(p.associationId);
      return this.toSafeProduct({
        ...p,
        viewerIsCotisant: status?.isCotisant ?? false,
        viewerActiveTier: status?.activeTier ?? null,
      });
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
    assocIds: string[]
  ): Promise<Map<string, { isCotisant: boolean; activeTier: string | null }>> {
    const result = new Map<string, { isCotisant: boolean; activeTier: string | null }>();
    if (assocIds.length === 0) return result;
    const [assos, tierProducts, activeTags] = await Promise.all([
      this.assoRepo.find({
        where: { id: In(assocIds) },
        select: { id: true, slug: true, cotisationMode: true },
      }),
      // Every tier, on sale or not: `isActive` gates BUYING a forfait, never recognizing the one
      // a user already holds (see `listCotisationTiers`).
      this.productRepo.find({
        where: { associationId: In(assocIds), type: 'membership' },
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
          variantKey
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
  async listByAssoc(associationId: string): Promise<SafeProduct[]> {
    const products = await this.productRepo.find({
      where: { associationId, isActive: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return products.map((p) => this.toSafeProduct(p));
  }

  /** Returns all products for admin (including inactive), ordered by sortOrder. */
  async listAllByAssoc(associationId: string): Promise<SafeProduct[]> {
    const products = await this.productRepo.find({
      where: { associationId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return products.map((p) => this.toSafeProduct(p));
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
    isGlobalAdmin: boolean
  ): Promise<SafeProduct> {
    this.logger.debug(
      `[SHOP] create product: association=${associationId.slice(0, 8)} type=${dto.type} isGlobalAdmin=${isGlobalAdmin}`
    );
    if (dto.type === 'balance_topup' && !isGlobalAdmin) {
      this.logger.debug(
        `[CERCLE] rejected balance_topup creation by non-global-admin for association=${associationId.slice(0, 8)}`
      );
      throw new ForbiddenException(
        'Only platform global admins may create Cercle balance_topup products'
      );
    }

    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');

    if (
      dto.customAmountMinCents !== undefined &&
      dto.customAmountMaxCents !== undefined &&
      dto.customAmountMinCents > dto.customAmountMaxCents
    ) {
      throw new BadRequestException('customAmountMinCents must be ≤ customAmountMaxCents');
    }

    const { webhookUrl, webhookSecret, ...rest } = dto;

    // Membership tiers derive their granted tag server-side from the association's own
    // slug/mode + this tier's variantKey - the single source of truth (`deriveCotisationTag`),
    // never a client-supplied value, so tag/product data can't drift apart.
    let grantedTagName = rest.grantedTagName ?? null;
    let tagExpiresAt: Date | null = rest.tagExpiresAt ? new Date(rest.tagExpiresAt) : null;
    if (dto.type === 'membership') {
      if (!asso.cotisationMode) {
        throw new BadRequestException('Cotisation must be enabled before adding a tier product');
      }
      await this.assertVariantKeyFree(associationId, dto.variantKey ?? null);
      const derived = deriveCotisationTag(
        asso.slug,
        asso.cotisationMode,
        new Date(),
        dto.variantKey ?? null
      );
      grantedTagName = derived.tagName;
      tagExpiresAt = derived.expiresAt;
    }

    // Payments may be served by an approved parent's account (delegation), so gate on the
    // resolved target's readiness rather than this association's own onboarding flag.
    const paymentTarget = await this.resolvePaymentTargetFor(asso);
    const product = this.productRepo.create({
      ...rest,
      currency: 'eur',
      associationId,
      grantedTagName,
      tagExpiresAt,
      // A balance top-up is repeatable by definition and cannot run out - it credits an account on
      // another site. The default `allowRepeatPurchase: false` would cap every user at one recharge
      // for life, and a purchase cap would put a top-up "out of stock".
      ...(dto.type === 'balance_topup'
        ? { allowRepeatPurchase: true, maxPurchasesPerUser: null, maxPurchasesTotal: null }
        : { allowRepeatPurchase: rest.allowRepeatPurchase }),
      webhookUrl: webhookUrl ?? null,
      webhookSecret: webhookSecret ?? null,
      // Product is inactive until payments can be taken (own or delegated Stripe account ready).
      isActive: paymentTarget.ready ? (dto.isActive ?? true) : false,
    });
    return this.toSafeProduct(await this.productRepo.save(product));
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
    isGlobalAdmin: boolean
  ): Promise<SafeProduct> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException('Product not found');

    if (product.type === 'balance_topup' && !isGlobalAdmin) {
      this.logger.debug(
        `[CERCLE] rejected balance_topup update by non-global-admin for product=${productId.slice(0, 8)}`
      );
      throw new ForbiddenException(
        'Only platform global admins may modify Cercle balance_topup products'
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
      throw new BadRequestException('customAmountMinCents must be ≤ customAmountMaxCents');
    }

    const retagging =
      product.type === 'membership' &&
      dto.variantKey !== undefined &&
      (dto.variantKey ?? null) !== product.variantKey
        ? await this.planTierRetag(product, dto.variantKey ?? null)
        : null;

    Object.assign(product, dto, { currency: 'eur' });
    // Same rule as on creation, and it also repairs a top-up product created before it existed:
    // saving the product from /admin/cercle is enough to make it repeatable and unlimited again.
    if (product.type === 'balance_topup') {
      product.allowRepeatPurchase = true;
      product.maxPurchasesPerUser = null;
      product.maxPurchasesTotal = null;
    }
    if (!retagging) return this.toSafeProduct(await this.productRepo.save(product));

    product.grantedTagName = retagging.newTagName;
    product.tagExpiresAt = retagging.newExpiresAt;
    // Renaming the tier's tag and the tags already granted under it must be one transaction:
    // half-applied, every cotisant of this tier silently stops being one.
    return this.productRepo.manager.transaction(async (manager) => {
      const saved = await manager.save(AssociationProduct, product);
      const result: { affected?: number | null } = await manager
        .createQueryBuilder()
        .update('user_tags')
        .set({ tagName: retagging.newTagName, expiresAt: retagging.newExpiresAt })
        .where('"issuingAssocId" = :assocId AND "tagName" = :oldTag', {
          assocId: product.associationId,
          oldTag: retagging.oldTagName,
        })
        .execute();
      this.logger.log(
        `[COTISATION] retagged tier ${product.id.slice(0, 8)}: "${retagging.oldTagName}" -> "${retagging.newTagName}" (${result.affected ?? 0} cotisant tag(s) migrated)`
      );
      return this.toSafeProduct(saved);
    });
  }

  /**
   * Prepares a membership tier's move to a different `variantKey`: rejects a collision with a
   * sibling tier and resolves the old/new derived tag names.
   *
   * Retiering exists so an association that outgrew its single base tier can convert the
   * auto-provisioned base product into a named one (WP-COT-11) instead of being stuck with a tier
   * that reports `tier: null` to consumers such as Le Cercle. Because the tag is fully derived,
   * the existing cotisants can be carried over by renaming their tag - nobody loses their
   * cotisation over an admin re-labelling their forfaits.
   */
  private async planTierRetag(
    product: AssociationProduct,
    newVariantKey: string | null
  ): Promise<{ oldTagName: string; newTagName: string; newExpiresAt: Date | null }> {
    const asso = await this.assoRepo.findOne({ where: { id: product.associationId } });
    if (!asso?.cotisationMode) {
      throw new BadRequestException('Cotisation must be enabled to change a tier');
    }
    await this.assertVariantKeyFree(product.associationId, newVariantKey, product.id);

    const now = new Date();
    const oldTag = deriveCotisationTag(asso.slug, asso.cotisationMode, now, product.variantKey);
    const newTag = deriveCotisationTag(asso.slug, asso.cotisationMode, now, newVariantKey);
    return {
      oldTagName: oldTag.tagName,
      newTagName: newTag.tagName,
      newExpiresAt: newTag.expiresAt,
    };
  }

  /**
   * Throws when another membership product of the association already claims `variantKey`.
   * Two tiers sharing a key would derive the same tag, making the forfait a coin flip: the XOR
   * revoke, the roster label and `cotisant-status` would each pick whichever row they saw first.
   */
  private async assertVariantKeyFree(
    associationId: string,
    variantKey: string | null,
    exceptProductId?: string
  ): Promise<void> {
    const siblings = await this.productRepo.find({
      where: { associationId, type: 'membership' },
    });
    const clash = siblings.find(
      (p) => p.id !== exceptProductId && (p.variantKey ?? null) === variantKey
    );
    if (clash) {
      throw new BadRequestException(
        variantKey
          ? `Tier "${variantKey}" already exists for this association`
          : 'This association already has a base tier'
      );
    }
  }

  /**
   * Removes a product from the association's boutique.
   *
   * Refuses to delete the association's LAST membership product while cotisations are enabled:
   * with no tier left, `deriveCotisationTag` still answers but nothing grants or recognizes the
   * tag, so the whole cotisation silently stops working. Dropping the now-redundant base tier of
   * a multi-tier association is exactly what this DOES allow (WP-COT-11).
   */
  async delete(associationId: string, productId: string): Promise<void> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.type === 'membership') {
      const asso = await this.assoRepo.findOne({ where: { id: associationId } });
      const remaining = await this.productRepo.count({
        where: { associationId, type: 'membership' },
      });
      if (asso?.cotisationMode && remaining <= 1) {
        throw new BadRequestException(
          'Cannot delete the last cotisation tier while cotisations are enabled'
        );
      }
    }
    await this.productRepo.remove(product);
  }

  // ── Cotisation config ─────────────────────────────────────────────────────

  /**
   * Upserts the canonical `membership` product(s) for an association whose cotisations are
   * enabled (D1, WP-COT-6): derives each tier's `grantedTagName`/`tagExpiresAt` from
   * `deriveCotisationTag` (keyed on that product's own `variantKey`) so every tier's granted tag
   * always matches the association's current slug/mode. Called after `PATCH /associations/:id`
   * when `cotisationEnabled` is true.
   *
   * On first activation (no membership product yet) this creates the single base tier
   * (`variantKey: null`). Once tiers exist, ALL of them are resynced - not just one - since a
   * multi-tier association (e.g. Le Cercle) has several. Each product's `name`/`amountCents`/
   * `variantKey` are preserved across calls, so this never overwrites admin edits made through
   * the regular product endpoints - it only ever (re)synchronizes the derived tag fields.
   */
  async provisionCotisationProduct(asso: Association): Promise<AssociationProduct> {
    this.logger.debug(
      `[COTISATION] provisioning canonical product(s): association=${asso.id.slice(0, 8)} mode=${asso.cotisationMode}`
    );
    if (!asso.cotisationMode) {
      throw new BadRequestException('cotisationMode is required when cotisationEnabled is true');
    }
    const cotisationMode = asso.cotisationMode;

    const existing = await this.productRepo.find({
      where: { associationId: asso.id, type: 'membership' },
    });

    if (existing.length === 0) {
      const { tagName, expiresAt } = deriveCotisationTag(asso.slug, cotisationMode);
      this.logger.log(
        `[COTISATION] creating canonical membership product for association=${asso.id.slice(0, 8)} tag=${tagName}`
      );
      const product = this.productRepo.create({
        associationId: asso.id,
        name: 'Cotisation',
        currency: 'eur',
        type: 'membership',
        grantedTagName: tagName,
        tagExpiresAt: expiresAt,
        // Active once payments can be taken - own account or an approved parent's (delegation).
        isActive: (await this.resolvePaymentTargetFor(asso)).ready,
      });
      return this.productRepo.save(product);
    }

    this.logger.log(
      `[COTISATION] resyncing ${existing.length} membership tier(s) for association=${asso.id.slice(0, 8)}`
    );
    const resynced = await Promise.all(
      existing.map((product) => {
        const { tagName, expiresAt } = deriveCotisationTag(
          asso.slug,
          cotisationMode,
          new Date(),
          product.variantKey
        );
        product.grantedTagName = tagName;
        product.tagExpiresAt = expiresAt;
        return this.productRepo.save(product);
      })
    );
    return resynced.find((p) => p.variantKey === null) ?? resynced[0];
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
    callbackUrls?: { successUrl?: string; cancelUrl?: string }
  ): Promise<{ checkoutUrl: string; amountCents: number; currency: string }> {
    const { product, amountCents, paymentTarget } = await this.resolvePurchase(
      associationId,
      productId,
      userId,
      customAmountCents
    );

    const paymentBase = this.paymentBase;
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost';

    // Resolve the Stripe customer ID so the card gets saved after checkout
    let customerId: string | undefined;
    try {
      const resp = await firstValueFrom(
        this.httpService.post<{ customerId: string | null }>(
          `${paymentBase}/api/payments/internal/customer-id`,
          { userId },
          { maxRedirects: 0 }
        )
      );
      customerId = resp.data.customerId ?? undefined;
    } catch {
      this.logger.warn(`Could not resolve Stripe customerId for user ${userId}`);
    }

    const successUrl = resolveStripeCallbackUrl(
      callbackUrls?.successUrl,
      `${frontendUrl}/shop?purchase_success=1&productId=${product.id}`,
      frontendUrl
    );
    const cancelUrl = resolveStripeCallbackUrl(
      callbackUrls?.cancelUrl,
      `${frontendUrl}/shop?purchase_cancel=1`,
      frontendUrl
    );

    // order_ref for Lydia's request/do callback (see webhook.controller.ts) - never sent for
    // Stripe, which would otherwise read it as its own idempotency key and could wrongly collapse
    // two genuine same-day purchases of the same product into one cached session.
    const idempotencyKey =
      paymentTarget.provider === 'lydia' ? `product:${product.id}:${userId}` : undefined;

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
          stripeConnectAccountId: paymentTarget.connectAccountId,
          customerId,
          idempotencyKey,
        },
        { maxRedirects: 0 }
      )
    );

    if (!resp.data?.url) {
      throw new BadRequestException('Payment service did not return a checkout URL');
    }

    this.logger.log(
      `[SHOP] Checkout session created: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)}`
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
    customAmountCents?: number
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
      customAmountCents
    );
    this.logger.debug(
      `[SHOP] charge context: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)} amount=${amountCents}`
    );
    return {
      productId: product.id,
      userId,
      amountCents,
      currency: product.currency,
      // resolvePurchase guarantees paymentTarget.ready + non-null connectAccountId.
      stripeAccountId: paymentTarget.connectAccountId,
    };
  }

  /**
   * Loads product/association, validates purchase rules, and resolves the amount in cents.
   *
   * `skipPaymentReadiness` drops the two checks that are purely about taking money - the product
   * being on sale and the Stripe target being onboarded - and is used ONLY by the admin test
   * top-up, which charges nothing. Everything else (gating, purchase limits, the server-side
   * amount) is validated identically, so the test still exercises the real rules.
   */
  private async resolvePurchase(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number,
    opts: { skipPaymentReadiness?: boolean } = {}
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

    if (!asso) throw new NotFoundException('Association not found');
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive && !opts.skipPaymentReadiness) {
      throw new NotFoundException('Product not found or inactive');
    }

    // Route to the association's own account, or an approved parent's when delegating.
    const paymentTarget = await this.resolvePaymentTargetFor(asso);
    if (!opts.skipPaymentReadiness && (!paymentTarget.ready || !paymentTarget.connectAccountId)) {
      throw new BadRequestException(
        paymentTarget.delegated
          ? 'The parent association this club delegates payments to has not completed onboarding to receive payments'
          : 'Association has not completed onboarding to receive payments'
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
          `[SHOP] member price applied: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} amount=${amountCents}`
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
      throw new BadRequestException('No amount provided for this product');
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
      source: 'form' | 'product';
      productId: string | null;
      formId: string | null;
      productName: string;
      amountCents: number;
      paymentMethod: 'stripe' | 'cash';
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
    associationId: string
  ): Promise<{ buffer: Buffer; title: string }> {
    this.logger.debug(`[SHOP] exportAssociationPurchases assoc=${associationId.slice(0, 8)}`);
    const nameRows: { name: string }[] = await this.productRepo.manager.query(
      `SELECT name FROM associations WHERE id = $1`,
      [associationId]
    );
    const assocName = nameRows[0]?.name ?? 'achats';
    const purchases = await this.listAssociationPurchases(associationId);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Achats');
    sheet.columns = [
      { header: 'Nom', key: 'lastName', width: 20 },
      { header: 'Prénom', key: 'firstName', width: 20 },
      { header: 'Type', key: 'source', width: 12 },
      { header: 'Produit', key: 'productName', width: 30 },
      { header: 'Montant', key: 'amount', width: 12, style: { numFmt: '0.00 "€"' } },
      { header: 'Paiement', key: 'paymentMethod', width: 12 },
      { header: 'Date', key: 'paidAt', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
    ];

    purchases.forEach((p) => {
      sheet.addRow({
        lastName: p.lastName ?? '',
        firstName: p.firstName ?? '',
        source: p.source === 'form' ? 'Formulaire' : 'Boutique',
        productName: p.productName,
        amount: p.amountCents / 100,
        paymentMethod: p.paymentMethod === 'cash' ? 'Espèces' : 'Stripe',
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
    productId: string
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
    if (!product) throw new NotFoundException('Product not found');

    const records = await this.purchaseRecordService.listPaidByProduct(productId);
    return this.enrichPurchaseRecords(records);
  }

  /** Attaches buyer display names to purchase records. */
  private async enrichPurchaseRecords(records: PurchaseRecord[]): Promise<
    Array<{
      id: string;
      userId: string;
      source: 'form' | 'product';
      productId: string | null;
      formId: string | null;
      productName: string;
      amountCents: number;
      paymentMethod: 'stripe' | 'cash';
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
          [userIds]
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
   * Resolves a user's cotisant status for an association by slug, for the inbound Cercle
   * `GET /public/cotisant-status` check (WP-COT-4). Mirrors `isBuyerCotisant`'s tier enumeration
   * but also surfaces WHICH tier tag is held and its expiry, since Cercle needs to distinguish
   * forfaits rather than a plain yes/no. Throws NotFoundException for an unknown slug.
   */
  async getCotisantStatusBySlug(
    assoSlug: string,
    userId: string
  ): Promise<{ isCotisant: boolean; tier: string | null; expiresAt: string | null }> {
    const asso = await this.assoRepo.findOne({ where: { slug: assoSlug } });
    if (!asso) throw new NotFoundException('Association not found');
    if (!asso.cotisationMode) return { isCotisant: false, tier: null, expiresAt: null };

    // Deliberately not filtered on `isActive`: a tier withdrawn from sale (or never put on sale,
    // an association with no Stripe account yet) still has cotisants, and answering `false` here
    // locks every one of them out of the Cercle.
    const tiers = await this.productRepo.find({
      where: { associationId: asso.id, type: 'membership' },
      select: { variantKey: true },
    });
    for (const variantKey of tierVariantKeys(tiers)) {
      const { tagName } = deriveCotisationTag(
        asso.slug,
        asso.cotisationMode,
        new Date(),
        variantKey
      );
      const tag = await this.userTagService.getActiveTag(userId, tagName);
      if (tag) {
        return {
          isCotisant: true,
          tier: variantKey,
          expiresAt: tag.expiresAt?.toISOString() ?? null,
        };
      }
    }
    return { isCotisant: false, tier: null, expiresAt: null };
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
    // All tiers, sellable or not - holding a withdrawn tier's tag still makes you a cotisant.
    const tiers = await this.productRepo.find({
      where: { associationId: asso.id, type: 'membership' },
      select: { variantKey: true },
    });
    for (const variantKey of tierVariantKeys(tiers)) {
      const { tagName } = deriveCotisationTag(
        asso.slug,
        asso.cotisationMode,
        new Date(),
        variantKey
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
    isCotisant: boolean
  ): Promise<void> {
    const requiredTags = product.requiredTags ?? [];
    this.logger.debug(
      `[SHOP] assertCanPurchase: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} membersOnly=${product.membersOnly} requiredTags=${requiredTags.length} isCotisant=${isCotisant}`
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
        `[SHOP] rejected: product=${product.id.slice(0, 8)} gating not satisfied for user=${userId.slice(0, 8)}`
      );
      throw new ForbiddenException(
        requiredTags.length > 0
          ? 'This product is reserved to users holding one of the required tags'
          : "This product is reserved to the association's cotisants"
      );
    }

    // A balance top-up is a recharge of an account on another site: repeatable by definition and
    // impossible to exhaust. The three shop columns below are meaningless for that type, and a row
    // created before `create`/`update` started forcing them still carries the restrictive defaults
    // - so the TYPE decides here, not the stored data.
    if (product.type === 'balance_topup') {
      this.logger.debug(
        `[SHOP] purchase limits waived: balance_topup product=${product.id.slice(0, 8)}`
      );
      return;
    }

    const paidCount = await this.purchaseRecordService.countPaidByUserAndProduct(
      userId,
      product.id
    );

    if (product.maxPurchasesTotal != null) {
      const totalPaid = await this.purchaseRecordService.countPaidByProduct(product.id);
      if (totalPaid >= product.maxPurchasesTotal) {
        throw new BadRequestException('Ce produit est en rupture de stock');
      }
    }

    if (product.allowRepeatPurchase) {
      if (product.maxPurchasesPerUser != null && paidCount >= product.maxPurchasesPerUser) {
        throw new BadRequestException("Limite d'achats atteinte pour ce produit");
      }
      return;
    }

    if (paidCount === 0) return;

    if (product.type === 'membership' && product.grantedTagName) {
      // Renewal: allow re-buying once the CURRENT tag has expired. Resolve the effective tag
      // (derived per academic year for cotisation-mode associations) rather than the stored one,
      // so the check stays correct across a yearly rollover.
      const grant = await this.resolveGrantTag(product);
      if (grant) {
        const hasTag = await this.userTagService.hasActiveTag(userId, grant.tagName);
        if (!hasTag) return;
      }
    }

    throw new BadRequestException('You have already purchased this product');
  }

  /**
   * Manually records a product purchase for a user (cash payment, retroactive grant).
   * Grants membership tags like a real purchase but does not dispatch Cercle webhooks.
   */
  async grantProductPurchase(
    associationId: string,
    productId: string,
    grantedBy: string,
    dto: GrantProductPurchaseDto
  ): Promise<{
    id: string;
    userId: string;
    source: 'form' | 'product';
    productId: string | null;
    formId: string | null;
    productName: string;
    amountCents: number;
    paymentMethod: 'stripe' | 'cash';
    paidAt: string;
    firstName: string | null;
    lastName: string | null;
  }> {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException('Product not found');

    const userRows: { id: string }[] = await this.productRepo.manager.query(
      `SELECT id FROM users WHERE id = $1`,
      [dto.userId]
    );
    if (userRows.length === 0) throw new NotFoundException('User not found');

    let amountCents: number;
    if (dto.amountCents != null) {
      amountCents = dto.amountCents;
    } else if (product.amountCents != null) {
      amountCents = product.amountCents;
    } else {
      throw new BadRequestException('amountCents is required for this product');
    }

    if (product.allowCustomAmount && product.customAmountMinCents != null) {
      const min = product.customAmountMinCents;
      const max = product.customAmountMaxCents ?? Infinity;
      if (amountCents < min || amountCents > max) {
        throw new BadRequestException(`amountCents must be between ${min} and ${max}`);
      }
    }

    this.logger.log(
      `[SHOP] manual grant: product=${productId.slice(0, 8)} user=${dto.userId.slice(0, 8)} by=${grantedBy.slice(0, 8)}`
    );

    const record = await this.fulfillProductPurchase({
      product,
      userId: dto.userId,
      amountCents,
      paymentMethod: 'cash',
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
    paymentIntentId: string
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
      paymentMethod: 'stripe',
      stripePaymentIntentId: paymentIntentId,
      grantedBy: 'system',
      dispatchWebhook: true,
    });

    this.logger.log(
      `[SHOP] purchase completed: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)}`
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
    product: AssociationProduct
  ): Promise<{ tagName: string; expiresAt: Date | null } | null> {
    if (product.type !== 'membership' || !product.grantedTagName) return null;
    const asso = await this.assoRepo.findOne({ where: { id: product.associationId } });
    if (asso?.cotisationMode) {
      return deriveCotisationTag(asso.slug, asso.cotisationMode, new Date(), product.variantKey);
    }
    return { tagName: product.grantedTagName, expiresAt: product.tagExpiresAt ?? null };
  }

  /** Grants tags, optionally dispatches webhooks, and persists the purchase record. */
  private async fulfillProductPurchase(params: {
    product: AssociationProduct;
    userId: string;
    amountCents: number;
    paymentMethod: 'stripe' | 'cash';
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
              manualGrant: paymentMethod === 'cash',
            },
          },
          manager
        );
        this.logger.log(`[SHOP] tag "${grant.tagName}" granted to user=${userId.slice(0, 8)}`);
        // XOR: buying one tier drops the buyer's other tiers, in the same transaction as the
        // grant so a switch is atomic and never leaves two forfaits held at once.
        await this.userTagService.revokeSiblingTierTags(
          product.associationId,
          userId,
          product.variantKey,
          manager
        );
      });
    }

    if (
      dispatchWebhook &&
      product.type === 'balance_topup' &&
      product.webhookUrl &&
      product.webhookSecret &&
      stripePaymentIntentId
    ) {
      await this.dispatchCercleWebhook(product, userId, amountCents, stripePaymentIntentId);
    }

    return this.purchaseRecordService.create({
      userId,
      source: 'product',
      productId: product.id,
      amountCents,
      paymentMethod,
      status: 'paid',
      stripePaymentIntentId,
      associationId: product.associationId,
      productName: product.name,
    });
  }

  // ── Cercle webhook ────────────────────────────────────────────────────────

  /**
   * Sends one signed request, and says why it failed.
   *
   * The payload and the signature are built HERE rather than once per dispatch, so every attempt -
   * including a retry days later - carries a fresh timestamp and is signed with the secret the
   * product holds NOW. That is what makes fixing a wrong `webhookUrl` or a rotated secret and
   * pressing retry work at all.
   *
   * @returns null when delivered, otherwise the error to record
   */
  private async sendCercleWebhook(
    product: AssociationProduct,
    delivery: WebhookDelivery
  ): Promise<string | null> {
    const payload = JSON.stringify({
      productId: product.id,
      userId: delivery.userId,
      amountCents: delivery.amountCents,
      paymentIntentId: delivery.paymentIntentId,
      timestamp: new Date().toISOString(),
    });

    const signature = createHmac('sha256', product.webhookSecret).update(payload).digest('hex');

    try {
      await firstValueFrom(
        this.httpService.post(product.webhookUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Canari-Signature': `sha256=${signature}`,
          },
          timeout: 10_000,
          maxRedirects: 0,
          validateStatus: (s) => s >= 200 && s < 300,
        })
      );

      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : '[unknown error]';
    }
  }

  /** When the scheduler should try this row again, or null once the ladder is exhausted. */
  private nextAutoRetryAt(autoRetryCount: number): Date | null {
    const backoff = CERCLE_AUTO_RETRY_BACKOFF[autoRetryCount];

    return backoff === undefined ? null : new Date(Date.now() + backoff);
  }

  /**
   * Runs a ladder of attempts against ONE delivery row, updating it in place.
   *
   * `delays[0]` is not waited: the first attempt of any ladder happens immediately.
   *
   * @returns whether the Cercle accepted it
   */
  private async runDeliveryAttempts(
    product: AssociationProduct,
    delivery: WebhookDelivery,
    delays: number[]
  ): Promise<boolean> {
    let lastError = '';

    for (let i = 0; i < delays.length; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, delays[i]));
      }
      // Accumulated, not assigned: `attemptCount` is how many times this top-up has been sent in
      // total, across the initial dispatch and every retry since.
      delivery.attemptCount += 1;
      delivery.lastAttemptAt = new Date();

      const error = await this.sendCercleWebhook(product, delivery);
      if (error === null) {
        delivery.status = 'delivered';
        delivery.lastError = null;
        delivery.nextAttemptAt = null;
        await this.deliveryRepo.save(delivery);
        this.logger.log(
          `[CERCLE] webhook delivered: product=${product.id.slice(0, 8)} intent=${delivery.paymentIntentId} attempts=${delivery.attemptCount}`
        );

        return true;
      }

      lastError = error;
      this.logger.warn(`[CERCLE] webhook attempt ${delivery.attemptCount} failed: ${lastError}`);
    }

    delivery.status = 'failed';
    delivery.lastError = lastError;
    delivery.nextAttemptAt = this.nextAutoRetryAt(delivery.autoRetryCount);
    await this.deliveryRepo.save(delivery);
    this.logger.error(
      `[CERCLE] delivery failed for intent=${delivery.paymentIntentId}: ${
        delivery.nextAttemptAt
          ? `next automatic attempt at ${delivery.nextAttemptAt.toISOString()}`
          : 'automatic retries exhausted, needs a human'
      }`
    );

    return false;
  }

  /**
   * Dispatches a signed Cercle balance_topup webhook with up to 3 immediate delivery attempts.
   * Records ONE `webhook_deliveries` row, which every later retry updates rather than duplicates.
   */
  async dispatchCercleWebhook(
    product: AssociationProduct,
    userId: string,
    amountCents: number,
    paymentIntentId: string
  ): Promise<void> {
    const delivery = await this.deliveryRepo.save(
      this.deliveryRepo.create({
        productId: product.id,
        userId,
        amountCents,
        paymentIntentId,
        status: 'pending',
        // Set here rather than left to the column defaults: `runDeliveryAttempts` increments them,
        // and `undefined + 1` is NaN - which reads as a row that has never been tried.
        attemptCount: 0,
        autoRetryCount: 0,
      })
    );

    await this.runDeliveryAttempts(product, delivery, CERCLE_RETRY_DELAYS);
  }

  /**
   * Runs a Cercle top-up end to end for `userId` WITHOUT charging a card: everything a real
   * purchase does is executed unchanged - buyer gating and purchase limits, server-side amount
   * resolution, tag grants, the signed webhook with its 3 delivery attempts, the
   * `webhook_deliveries` audit row and the `purchase_records` row. Only Stripe is left out: the
   * PaymentIntent is synthetic and the two conditions that exist solely to take money (product on
   * sale, Connect account onboarded) are waived, so nothing is charged and no money moves.
   *
   * It deliberately reuses `resolvePurchase` (the checkout-side validation) and
   * `handlePurchaseCompleted` (the exact entry point core-service calls from the Stripe webhook)
   * instead of re-implementing them: a parallel implementation would only ever prove itself.
   *
   * The synthetic intent is prefixed `pi_canari_test_`, so the rows it leaves are identifiable on
   * both sides (Canari `purchase_records`/`webhook_deliveries`, Cercle
   * `account_movements.idempotency_key`). Global-admin only, caller-credits-caller only (see the
   * controller) - it is a deployment check, not a way to hand out balance.
   */
  async simulateCercleTopup(
    associationId: string,
    productId: string,
    userId: string,
    requestedAmountCents: number
  ): Promise<{
    paymentIntentId: string;
    amountCents: number;
    status: 'pending' | 'delivered' | 'failed';
    attemptCount: number;
    lastError: string | null;
  }> {
    this.logger.log(
      `[CERCLE][TEST] simulated top-up requested: association=${associationId.slice(0, 8)} product=${productId.slice(0, 8)} user=${userId.slice(0, 8)} requested=${requestedAmountCents}`
    );

    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.type !== 'balance_topup') {
      throw new BadRequestException('Only balance_topup (Cercle) products can be test-credited');
    }
    // The real fulfillment SKIPS the dispatch silently when either field is missing, so without
    // this guard the test would report a flawless success while nothing was ever sent.
    if (!product.webhookUrl || !product.webhookSecret) {
      throw new BadRequestException(
        'This product has no webhookUrl/webhookSecret: a real purchase would credit nothing on the Cercle side'
      );
    }

    // Same checks a real checkout runs - buyer gating, purchase limits, server-side amount. The
    // resolved amount wins over the requested one exactly as it would for a paying buyer, so a
    // fixed-price product still credits its own price. Only the two Stripe-side conditions are
    // waived: nothing is charged here, so an association without a Connect account (or a product
    // left inactive because of it) must not block a webhook test.
    const { amountCents } = await this.resolvePurchase(
      associationId,
      productId,
      userId,
      requestedAmountCents,
      { skipPaymentReadiness: true }
    );

    const paymentIntentId = `pi_canari_test_${randomBytes(12).toString('hex')}`;
    await this.handlePurchaseCompleted(productId, userId, amountCents, paymentIntentId);

    const delivery = await this.deliveryRepo.findOne({ where: { paymentIntentId } });
    if (!delivery) {
      // Unreachable given the webhook config check above - but a missing audit row means the
      // dispatch never ran, which must never be reported as a delivered top-up.
      this.logger.error(
        `[CERCLE][TEST] no delivery row recorded for intent=${paymentIntentId} - dispatch was skipped`
      );
      return {
        paymentIntentId,
        amountCents,
        status: 'failed',
        attemptCount: 0,
        lastError: 'No webhook delivery was recorded',
      };
    }

    this.logger.log(
      `[CERCLE][TEST] simulated top-up done: intent=${paymentIntentId} amount=${amountCents} status=${delivery.status} attempts=${delivery.attemptCount}`
    );
    return {
      paymentIntentId,
      amountCents,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastError: delivery.lastError,
    };
  }

  // ── Webhook delivery admin ────────────────────────────────────────────────

  /**
   * Lists all failed Cercle webhook deliveries for an association's products.
   *
   * Enriched with the member's name and the product's: a delivery row carries a user uuid and a
   * product uuid, and neither tells an admin whose top-up is stuck - which is the first thing they
   * need in order to decide between retrying, settling it by hand, and dropping the row.
   */
  async listWebhookFailures(associationId: string): Promise<FailedDelivery[]> {
    const products = await this.productRepo.find({
      where: { associationId },
      select: { id: true, name: true },
    });
    if (products.length === 0) return [];

    const productNames = new Map(products.map((p) => [p.id, p.name]));
    const deliveries = await this.deliveryRepo
      .createQueryBuilder('d')
      .where('d.productId IN (:...ids)', { ids: [...productNames.keys()] })
      .andWhere("d.status = 'failed'")
      .orderBy('d.createdAt', 'DESC')
      .getMany();

    if (deliveries.length === 0) return [];

    const userIds = [...new Set(deliveries.map((d) => d.userId))];
    const rows: { id: string; firstName: string | null; lastName: string | null }[] =
      await this.deliveryRepo.manager.query(
        `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
        [userIds]
      );
    const names = new Map(rows.map((r) => [r.id, r]));

    return deliveries.map((d) => ({
      id: d.id,
      productId: d.productId,
      productName: productNames.get(d.productId) ?? null,
      userId: d.userId,
      // Null rather than a placeholder: a delivery whose user no longer exists is a different
      // problem from one whose user is simply not on the Cercle yet, and the UI must be able to
      // tell them apart.
      firstName: names.get(d.userId)?.firstName ?? null,
      lastName: names.get(d.userId)?.lastName ?? null,
      amountCents: d.amountCents,
      paymentIntentId: d.paymentIntentId,
      status: d.status,
      attemptCount: d.attemptCount,
      autoRetryCount: d.autoRetryCount,
      lastAttemptAt: d.lastAttemptAt ? d.lastAttemptAt.toISOString() : null,
      nextAttemptAt: d.nextAttemptAt ? d.nextAttemptAt.toISOString() : null,
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /**
   * Retries a failed webhook delivery, ONCE.
   *
   * One attempt rather than the three-step ladder the initial dispatch runs: that ladder sleeps 5 s
   * then 15 s between attempts, each with a 10 s timeout, so the admin's request could hang for the
   * better part of a minute and time out at the proxy - which is one of the two reasons this button
   * looked dead. The other was that it inserted a NEW row instead of updating this one, so the
   * failure it was pressed on stayed in the list whatever happened.
   *
   * The product is resolved through `associationId` as well, not by the delivery id alone:
   * `MANAGE_PRODUCTS` is granted per association, so an unscoped lookup would let an admin of any
   * association re-fire another one's top-up.
   */
  async retryWebhookDelivery(associationId: string, deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    const product = await this.productRepo.findOne({
      where: { id: delivery.productId, associationId },
    });
    if (!product) throw new NotFoundException('Webhook delivery not found');
    if (!product.webhookUrl || !product.webhookSecret) {
      throw new BadRequestException('Product webhook not configured');
    }

    // A manual retry means an admin changed something, so the automatic ladder starts over rather
    // than resuming at a 24 h step - or staying exhausted forever.
    delivery.autoRetryCount = 0;
    this.logger.log(
      `[CERCLE] manual retry of delivery ${deliveryId.slice(0, 8)} intent=${delivery.paymentIntentId}`
    );
    await this.runDeliveryAttempts(product, delivery, [0]);

    return delivery;
  }

  /**
   * Re-sends every failed delivery whose backoff has elapsed. Driven by the scheduler.
   *
   * The product is re-read for each row, so a corrected `webhookUrl` or a rotated secret is picked
   * up without anyone touching the delivery. A row whose product lost its webhook configuration is
   * taken OFF the ladder rather than retried into the void.
   *
   * @returns how many were delivered, out of how many were due
   */
  async retryDueWebhookDeliveries(): Promise<{ delivered: number; attempted: number }> {
    const due = await this.deliveryRepo
      .createQueryBuilder('d')
      .where("d.status = 'failed'")
      .andWhere('d.nextAttemptAt IS NOT NULL')
      .andWhere('d.nextAttemptAt <= :now', { now: new Date() })
      .orderBy('d.nextAttemptAt', 'ASC')
      .take(CERCLE_AUTO_RETRY_BATCH)
      .getMany();

    if (due.length === 0) return { delivered: 0, attempted: 0 };

    this.logger.log(`[CERCLE] ${due.length} failed deliveries due for an automatic retry`);

    let delivered = 0;
    for (const delivery of due) {
      const product = await this.productRepo.findOne({ where: { id: delivery.productId } });
      if (!product?.webhookUrl || !product.webhookSecret) {
        delivery.nextAttemptAt = null;
        delivery.lastError = 'Product webhook is not configured';
        await this.deliveryRepo.save(delivery);
        this.logger.warn(
          `[CERCLE] delivery ${delivery.id.slice(0, 8)} taken off the ladder: no webhook configured`
        );
        continue;
      }

      // Counted BEFORE the attempt, so a crash mid-retry cannot leave the row looping on the same
      // backoff step forever.
      delivery.autoRetryCount += 1;
      if (await this.runDeliveryAttempts(product, delivery, [0])) {
        delivered += 1;
      }
    }

    return { delivered, attempted: due.length };
  }

  /**
   * Drops a failed delivery from the audit list. The case this exists for: the top-up was settled
   * by hand on the Cercle side, so retrying would credit it twice and the row has nothing left to
   * say. Scoped to the association like the retry, and refuses anything but a `failed` row - a
   * delivered one is the record of a credit that really happened.
   */
  async deleteWebhookDelivery(associationId: string, deliveryId: string): Promise<void> {
    const delivery = await this.deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    const product = await this.productRepo.findOne({
      where: { id: delivery.productId, associationId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Webhook delivery not found');
    if (delivery.status !== 'failed') {
      throw new BadRequestException('Only a failed delivery can be deleted');
    }

    await this.deliveryRepo.remove(delivery);
    this.logger.log(
      `[CERCLE] deleted failed delivery ${deliveryId.slice(0, 8)} intent=${delivery.paymentIntentId}`
    );
  }
}
