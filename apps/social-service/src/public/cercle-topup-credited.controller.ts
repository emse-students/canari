import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import { ProductsService } from '../associations/products.service';
import { assertCercleApiKey } from './cercle-api-key';

/**
 * A payment intent as Canari sent it in the top-up (a Stripe `pi_...` or a Lydia request id): any
 * printable ASCII without a space, within the column's 255 - the exact string is the lookup key, so
 * nothing narrower is asserted about its shape.
 */
const PAYMENT_INTENT_ID = /^[!-~]{1,255}$/;

/**
 * Le Cercle -> Canari: "this parked top-up is now on the member's balance"
 * (docs/wiki/cotisations.md, "A parked top-up is SEEN, not swept").
 *
 * A top-up Le Cercle answered 202 for is `parked` here, and nothing on this side could learn when
 * the member's first sign-in credits it - so the admin list and the daily `[CERCLE_PARKED]` report
 * would keep it waiting for ever. Le Cercle calls this right after the credit commits, best-effort:
 * a lost call leaves the row parked, and the 7-day report then names a real wait to look at.
 *
 * Service-to-service, under `/api/public/` (nginx's location that skips `auth_request`): the same
 * `X-Api-Key` as `cotisant-status`, the only credential Le Cercle holds for Canari, and the same
 * throttle against key brute-forcing. A WRITE, so it is kept out of `PublicController`, whose
 * routes are read-only. What it can do with a key is bounded: settle a Cercle top-up as delivered.
 */
@Controller('public/cercle')
export class CercleTopupCreditedController {
  private readonly logger = new Logger(CercleTopupCreditedController.name);

  constructor(private readonly products: ProductsService) {}

  /** Marks the top-up of `paymentIntentId` delivered. Idempotent; 200 with the row's status. */
  @UseGuards(ClientIpThrottlerGuard)
  @Post('topup-credited')
  @HttpCode(200)
  async topupCredited(
    @Body() body: { paymentIntentId?: unknown } | undefined,
    @Headers('x-api-key') apiKey: string
  ) {
    assertCercleApiKey(apiKey);
    const paymentIntentId = body?.paymentIntentId;
    if (typeof paymentIntentId !== 'string' || !PAYMENT_INTENT_ID.test(paymentIntentId)) {
      this.logger.warn('[CERCLE] credited notice refused: no well-formed paymentIntentId');
      throw new BadRequestException('paymentIntentId is required');
    }
    return this.products.markCercleTopupCredited(paymentIntentId);
  }
}
