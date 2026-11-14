import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ProductsService } from '../associations/products.service';
import { AssociationsService } from '../associations/associations.service';
import {
  LYDIA_FLUX_LOG_TAG,
  isCalendarDate,
  measureLydiaFlux,
  type LydiaFluxMeasure,
} from '../associations/lydia-contract-flux';
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

  constructor(
    private readonly products: ProductsService,
    private readonly associations: AssociationsService,
    @InjectDataSource() private readonly ds: DataSource
  ) {}

  @Post('provider-activated')
  @HttpCode(200)
  async providerActivated(
    @Headers('x-internal-secret') secret: string | undefined
  ): Promise<{ released: number; failed: number }> {
    assertInternalSecret(secret);
    this.logger.log('[SHOP] provider-activated received from core-service');
    return this.products.releaseWithheldForAllAssociations();
  }

  /**
   * The platform's Lydia flux over `[from, to)` - two `YYYY-MM-DD` dates, a contract year that
   * core-service computes from the platform settings (`measureLydiaFlux`,
   * docs/wiki/lydia-contract-flux.md). Read-only. A bad window is a 400, never a guessed one.
   */
  @Get('lydia-flux')
  async lydiaFlux(
    @Headers('x-internal-secret') secret: string | undefined,
    @Query('from') from: unknown,
    @Query('to') to: unknown
  ): Promise<LydiaFluxMeasure> {
    assertInternalSecret(secret);
    if (!isCalendarDate(from) || !isCalendarDate(to) || from >= to) {
      this.logger.warn(`${LYDIA_FLUX_LOG_TAG} refused: the window is not two ordered dates`);
      throw new BadRequestException('from and to must be two ordered YYYY-MM-DD dates');
    }
    return measureLydiaFlux((sql, params) => this.ds.query(sql, params), from, to, this.logger);
  }

  /**
   * Whether a person may edit a price somewhere (`AssociationsService.mayEditAPrice`): what
   * core-service asks before it answers the payout estimate's fee schedule, a confidential contract
   * term (docs/wiki/lydia-contract-flux.md). The caller's identity is the one nginx set on the
   * core-service request, passed through; this route answers internal calls only.
   */
  @Get('may-edit-a-price')
  async mayEditAPrice(
    @Headers('x-internal-secret') secret: string | undefined,
    @Query('userId') userId: unknown,
    @Query('globalAdmin') globalAdmin: unknown
  ): Promise<{ ok: boolean }> {
    assertInternalSecret(secret);
    if (typeof userId !== 'string' || !userId.trim()) {
      this.logger.warn('[PERM] may-edit-a-price refused: no user id');
      throw new BadRequestException('userId is required');
    }
    return {
      ok: await this.associations.mayEditAPrice(userId.trim(), globalAdmin === 'true'),
    };
  }
}
