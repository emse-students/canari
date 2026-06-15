import { Body, Controller, ForbiddenException, Headers, Logger, Post } from '@nestjs/common';
import * as crypto from 'crypto';
import { ProductsService } from '../associations/products.service';

/**
 * Internal boutique endpoints for core-service (charge-product-saved-method).
 * Protected by X-Internal-Secret - not exposed through nginx auth headers.
 */
@Controller('internal/products')
export class InternalProductsController {
  private readonly logger = new Logger(InternalProductsController.name);
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor(private readonly productsService: ProductsService) {}

  /** Validates the shared internal secret header. */
  private assertInternalSecret(headerSecret: string | undefined): void {
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }
  }

  /** Returns product charge details for saved-card PaymentIntents. */
  @Post('charge-context')
  getChargeContext(
    @Headers('x-internal-secret') headerSecret: string,
    @Body()
    body: {
      associationId: string;
      productId: string;
      userId: string;
      customAmountCents?: number;
    }
  ) {
    this.assertInternalSecret(headerSecret);
    this.logger.debug(
      `[INTERNAL_PRODUCTS] charge-context product=${body.productId?.slice(0, 8)} user=${body.userId?.slice(0, 8)}`
    );
    return this.productsService.getChargeContext(
      body.associationId,
      body.productId,
      body.userId,
      body.customAmountCents
    );
  }
}
