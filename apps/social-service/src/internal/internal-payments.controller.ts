import { Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ProductsService } from '../associations/products.service';
import { assertInternalSecret } from './internal-secret.util';

/**
 * Tells social-service the platform's payment provider just became active (core-service calls it
 * after saving the new provider). Releases the boutique products that were withheld ONLY because
 * payments were disabled; see `ProductsService.releaseWithheldForAllAssociations`.
 *
 * Internal-only. Answers `{ released, failed }` so the caller can tell a partial sweep from a
 * complete one; it is idempotent, so the caller may simply call again.
 */
@Controller('internal/payments')
export class InternalPaymentsController {
  private readonly logger = new Logger(InternalPaymentsController.name);

  constructor(private readonly products: ProductsService) {}

  @Post('provider-activated')
  @HttpCode(200)
  async providerActivated(
    @Headers('x-internal-secret') secret: string | undefined
  ): Promise<{ released: number; failed: number }> {
    assertInternalSecret(secret);
    this.logger.log('[SHOP] provider-activated received from core-service');
    return this.products.releaseWithheldForAllAssociations();
  }
}
