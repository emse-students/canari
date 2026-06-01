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
import { resolveStripeCallbackUrl } from '../common/stripe-callback-url';
import { CreateProductDto, UpdateProductDto } from './dto/association.dto';

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
    customAmountCents?: number
  ): Promise<{ checkoutUrl: string }> {
    const [asso, product] = await Promise.all([
      this.assoRepo.findOne({ where: { id: associationId } }),
      this.productRepo.findOne({ where: { id: productId, associationId } }),
    ]);

    if (!asso) throw new NotFoundException('Association not found');
    if (!product || !product.isActive) throw new NotFoundException('Product not found or inactive');
    if (!asso.stripeOnboardingComplete || !asso.stripeAccountId) {
      throw new BadRequestException('Association has not completed Stripe Connect onboarding');
    }

    // Prevent duplicate purchases: check if user already has a completed purchase record.
    const existing = await this.purchaseRecordService.findByUserAndProduct(userId, productId);
    if (existing) {
      throw new BadRequestException('You have already purchased this product');
    }

    // Determine the final amount in cents
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

    const paymentBase = (
      this.config.get<string>('PAYMENT_SERVICE_URL') ?? 'http://localhost:3012'
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
      undefined,
      `${frontendUrl}/shop?purchase_success=1&productId=${product.id}`,
      frontendUrl
    );
    const cancelUrl = resolveStripeCallbackUrl(
      undefined,
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
    return { checkoutUrl: resp.data.url };
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
    // Idempotency guard
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

    if (product.type === 'membership' && product.grantedTagName) {
      await this.userTagService.grantOrRenew({
        userId,
        tagName: product.grantedTagName,
        issuingAssocId: product.associationId,
        grantedBy: 'system',
        expiresAt: product.tagExpiresAt ?? null,
        metadata: { productId, paymentIntentId },
      });
      this.logger.log(
        `[SHOP] tag "${product.grantedTagName}" granted to user=${userId.slice(0, 8)}`
      );
    }

    if (product.type === 'balance_topup' && product.webhookUrl && product.webhookSecret) {
      await this.dispatchCercleWebhook(product, userId, amountCents, paymentIntentId);
    }

    await this.purchaseRecordService.create({
      userId,
      source: 'product',
      productId,
      amountCents,
      paymentMethod: 'stripe',
      status: 'paid',
      stripePaymentIntentId: paymentIntentId,
      associationId: product.associationId,
      productName: product.name,
    });

    this.logger.log(
      `[SHOP] purchase completed: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)}`
    );
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
