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
 * THE LYDIA CASHIER ROUTE ONLY ANOTHER SERVICE CALLS (enrolment lot 3): the removal an account's
 * ERASURE asks for, from social-service. Under `/api/internal/`, which nginx does not route, and
 * `X-Internal-Secret` guarded before anything, like every internal route.
 */
@Controller('internal/lydia-cashiers')
export class InternalLydiaCashiersController {
  private readonly logger = new Logger(InternalLydiaCashiersController.name);

  constructor(private readonly paymentService: PaymentService) {}

  /**
   * Removes one number for an account's erasure: the numbers come in the body - opened by
   * social-service, which owns them, under the association's cashier claim - and nothing is recorded
   * here. The control read and the re-read are `LydiaPaymentProvider.removeCashier`'s; the answer is
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
      actorPhone?: unknown;
      cashierPhone?: unknown;
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
    this.logger.log(`Lydia cashiers of ${associationId}: removal asked by an account erasure`);
    return this.paymentService.removeLydiaCashier(
      associationId,
      vendorToken,
      text(body?.actorPhone),
      text(body?.cashierPhone)
    );
  }
}
