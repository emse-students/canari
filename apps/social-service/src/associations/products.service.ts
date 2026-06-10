import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { AssociationProduct } from './entities/association-product.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { Association } from './entities/association.entity';
import { UserTagService } from '../users/user-tag.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { resolveStripeCallbackUrl } from '../common/stripe-callback-url';
import { CreateProductDto, GrantProductPurchaseDto, UpdateProductDto } from './dto/association.dto';

/** Delays used between Cercle webhook delivery attempts (ms). */
const CERCLE_RETRY_DELAYS = [1_000, 5_000, 15_000];

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

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Returns all active products across all associations (login required, listed on /shop). */
  async listAllActive(): Promise<AssociationProduct[]> {
    return this.productRepo.find({
      where: { isActive: true },
      order: { associationId: 'ASC', sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /** Returns active products for a single association ordered by sortOrder. */
  async listByAssoc(associationId: string): Promise<AssociationProduct[]> {
    return this.productRepo.find({
      where: { associationId, isActive: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /** Returns all products for admin (including inactive), ordered by sortOrder. */
  async listAllByAssoc(associationId: string): Promise<AssociationProduct[]> {
    return this.productRepo.find({
      where: { associationId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Creates a product for an association.
   * If Stripe Connect onboarding is incomplete the product is created but forced inactive.
   */
  async create(associationId: string, dto: CreateProductDto): Promise<AssociationProduct> {
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

    const product = this.productRepo.create({
      ...rest,
      associationId,
      webhookUrl: webhookUrl ?? null,
      webhookSecret: webhookSecret ?? null,
      // Product is inactive until Stripe Connect onboarding is complete
      isActive: asso.stripeOnboardingComplete ? (dto.isActive ?? true) : false,
    });
    return this.productRepo.save(product);
  }

  /** Updates mutable fields of a product. Ignores webhookSecret if not provided. */
  async update(
    associationId: string,
    productId: string,
    dto: UpdateProductDto
  ): Promise<AssociationProduct> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException('Product not found');

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

    Object.assign(product, dto);
    return this.productRepo.save(product);
  }

  /** Removes a product from the association's boutique. */
  async delete(associationId: string, productId: string): Promise<void> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException('Product not found');
    await this.productRepo.remove(product);
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
    const { asso, product, amountCents } = await this.resolvePurchase(
      associationId,
      productId,
      userId,
      customAmountCents
    );

    const paymentBase = (
      this.config.get<string>('PAYMENT_SERVICE_URL') ?? 'http://core-service:3012'
    ).replace(/\/$/, '');
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
          stripeConnectAccountId: asso.stripeAccountId,
          customerId,
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
    const { asso, product, amountCents } = await this.resolvePurchase(
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
      stripeAccountId: asso.stripeAccountId,
    };
  }

  /** Loads product/association, validates purchase rules, and resolves the amount in cents. */
  private async resolvePurchase(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number
  ): Promise<{ asso: Association; product: AssociationProduct; amountCents: number }> {
    const [asso, product] = await Promise.all([
      this.assoRepo.findOne({ where: { id: associationId } }),
      this.productRepo.findOne({ where: { id: productId, associationId } }),
    ]);

    if (!asso) throw new NotFoundException('Association not found');
    if (!product || !product.isActive) throw new NotFoundException('Product not found or inactive');
    if (!asso.stripeOnboardingComplete || !asso.stripeAccountId) {
      throw new BadRequestException('Association has not completed Stripe Connect onboarding');
    }

    await this.assertCanPurchase(product, userId);

    let amountCents: number;
    if (product.amountCents !== null) {
      amountCents = product.amountCents;
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

    return { asso, product, amountCents };
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

  /** Enforces per-user and global purchase limits and membership renewal rules. */
  private async assertCanPurchase(product: AssociationProduct, userId: string): Promise<void> {
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
      const hasTag = await this.userTagService.hasActiveTag(userId, product.grantedTagName);
      if (!hasTag) return;
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

    if (product.type === 'membership' && product.grantedTagName) {
      await this.userTagService.grantOrRenew({
        userId,
        tagName: product.grantedTagName,
        issuingAssocId: product.associationId,
        grantedBy,
        expiresAt: product.tagExpiresAt ?? null,
        metadata: {
          productId: product.id,
          paymentIntentId: stripePaymentIntentId,
          manualGrant: paymentMethod === 'cash',
        },
      });
      this.logger.log(
        `[SHOP] tag "${product.grantedTagName}" granted to user=${userId.slice(0, 8)}`
      );
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
   * Dispatches a signed Cercle balance_topup webhook with up to 3 delivery attempts.
   * Records each attempt in `webhook_deliveries` for admin visibility and manual retry.
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
      })
    );

    const payload = JSON.stringify({
      productId: product.id,
      userId,
      amountCents,
      paymentIntentId,
      timestamp: new Date().toISOString(),
    });

    const signature = createHmac('sha256', product.webhookSecret).update(payload).digest('hex');

    let lastError = '';
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
              'Content-Type': 'application/json',
              'X-Canari-Signature': `sha256=${signature}`,
            },
            timeout: 10_000,
            maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 300,
          })
        );

        delivery.status = 'delivered';
        delivery.lastError = null;
        await this.deliveryRepo.save(delivery);
        this.logger.log(
          `[CERCLE] webhook delivered: product=${product.id.slice(0, 8)} attempt=${i + 1}`
        );
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : '[unknown error]';
        this.logger.warn(`[CERCLE] webhook attempt ${i + 1} failed: ${lastError}`);
      }
    }

    delivery.status = 'failed';
    delivery.lastError = lastError;
    await this.deliveryRepo.save(delivery);
    this.logger.error(
      `[CERCLE] all ${CERCLE_RETRY_DELAYS.length} attempts failed for product=${product.id.slice(0, 8)}`
    );
  }

  // ── Webhook delivery admin ────────────────────────────────────────────────

  /** Lists all failed Cercle webhook deliveries for an association's products. */
  async listWebhookFailures(associationId: string): Promise<WebhookDelivery[]> {
    const productIds = await this.productRepo
      .find({ where: { associationId }, select: ['id'] })
      .then((ps) => ps.map((p) => p.id));

    if (productIds.length === 0) return [];

    return this.deliveryRepo
      .createQueryBuilder('d')
      .where('d.productId IN (:...ids)', { ids: productIds })
      .andWhere("d.status = 'failed'")
      .orderBy('d.createdAt', 'DESC')
      .getMany();
  }

  /** Retries a failed webhook delivery once. */
  async retryWebhookDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    const product = await this.productRepo.findOne({ where: { id: delivery.productId } });
    if (!product || !product.webhookUrl || !product.webhookSecret) {
      throw new BadRequestException('Product webhook not configured');
    }

    await this.dispatchCercleWebhook(
      product,
      delivery.userId,
      delivery.amountCents,
      delivery.paymentIntentId
    );
  }
}
