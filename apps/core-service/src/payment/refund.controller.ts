import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { assertInternalSecret } from '../internal/internal-secret.util';
import { parseLydiaOrderRef } from './lydia-order-ref';
import { LYDIA_MAX_AMOUNT_CENTS } from './lydia-payment-provider';
import { PaymentService } from './payment.service';

/**
 * The refund route (enrolment chantier lot 4). SERVER-TO-SERVER ONLY, like `cancel-request`:
 * social-service calls it AFTER it wrote its `pending` refund row, under its own permission check
 * and its sum cap; this route checks the payload, reads the Business key and asks Lydia.
 *
 * Answers `{ ok: true }` when Lydia answered `error: 0`. Every other outcome is typed
 * (`libs/contracts/lydia-refusal-codes.json`, `refund.core`): 409 for a refusal Lydia answered or a
 * missing key (nothing refunded), 504 `LYDIA_REFUND_UNCONFIRMED` when Lydia may have refunded, 503
 * `PAYMENT_SERVICE_NOT_READY` when nothing was sent. Kept in its own controller so the refund lot
 * touches neither the onboarding nor the cashier routes of `PaymentController`.
 */
@Controller('payments')
export class RefundController {
  private readonly logger = new Logger(RefundController.name);

  constructor(private readonly paymentService: PaymentService) {}

  /** Body: `{ vendorToken, orderRef, amountCents }` - the order_ref in Canari's own grammar only. */
  @Post('refund')
  @HttpCode(200)
  async refund(
    @Body() body: { vendorToken?: unknown; orderRef?: unknown; amountCents?: unknown },
    @Headers('x-internal-secret') secret?: string
  ) {
    assertInternalSecret(secret);
    const vendorToken = typeof body?.vendorToken === 'string' ? body.vendorToken.trim() : '';
    const orderRef = typeof body?.orderRef === 'string' ? body.orderRef : '';
    const amountCents = body?.amountCents;
    if (
      !vendorToken ||
      !parseLydiaOrderRef(orderRef) ||
      typeof amountCents !== 'number' ||
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      amountCents > LYDIA_MAX_AMOUNT_CENTS
    ) {
      this.logger.warn('[LYDIA-REFUND] refused: invalid payload');
      throw new BadRequestException('Invalid payload');
    }
    await this.paymentService.refundLydiaTransaction(vendorToken, orderRef, amountCents);
    return { ok: true };
  }
}
