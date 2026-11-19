import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { assertInternalSecret } from '../internal/internal-secret.util';
import type { LydiaCashierRemoval } from './lydia-payment-provider';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a `vendor_token` may look like in the removal's body: printable ASCII, bounded. */
const VENDOR_TOKEN_SHAPE = /^[\x21-\x7e]{1,256}$/;

/**
 * THE LYDIA CASHIER ROUTE ONLY ANOTHER SERVICE CALLS (enrolment lot 3): the removal social-service
 * asks for when an account is ERASED, or when a cashier's membership of the association ENDED (review
 * of the 1.7.1 flip). Under `/api/internal/`, which nginx does not route, and
 * `X-Internal-Secret` guarded before anything, like every internal route.
 */
@Controller('internal/lydia-cashiers')
export class InternalLydiaCashiersController {
  private readonly logger = new Logger(InternalLydiaCashiersController.name);

  constructor(private readonly paymentService: PaymentService) {}

  /**
   * Removes one number for an account's erasure or a cashier's departure (`reason`, absent = erasure,
   * the only caller before 1.7.1): the numbers come in the body - opened by
   * social-service, which owns them, under the association's cashier claim - and nothing is recorded
   * here. The checks before the removal and the re-read after it are `LydiaPaymentProvider.removeCashier`'s; the answer is
   * the re-read (`{ verified, held }`). Phones are never logged.
   */
  @Post('revoke')
  @HttpCode(200)
  async revokeForErasure(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body()
    body: {
      associationId?: unknown;
      vendorToken?: unknown;
      contextPhone?: unknown;
      cashierPhone?: unknown;
      reason?: unknown;
    }
  ): Promise<LydiaCashierRemoval> {
    assertInternalSecret(secret);
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const associationId = text(body?.associationId);
    const vendorToken = text(body?.vendorToken);
    if (!UUID_RE.test(associationId) || !VENDOR_TOKEN_SHAPE.test(vendorToken)) {
      this.logger.warn('Lydia cashier removal for an erasure refused: malformed body');
      throw new BadRequestException('associationId and vendorToken are required');
    }
    const reason = body?.reason === undefined ? 'erasure' : body.reason;
    if (reason !== 'erasure' && reason !== 'departure') {
      this.logger.warn('Lydia cashier removal for another service refused: unknown reason');
      throw new BadRequestException('reason must be erasure or departure');
    }
    this.logger.log(
      `Lydia cashiers of ${associationId}: removal asked by ${
        reason === 'erasure' ? 'an account erasure' : "a cashier's departure"
      }`
    );
    return this.paymentService.removeLydiaCashier(
      associationId,
      vendorToken,
      text(body?.contextPhone),
      text(body?.cashierPhone)
    );
  }
}
