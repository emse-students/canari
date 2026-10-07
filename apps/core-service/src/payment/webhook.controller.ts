import { BadRequestException, Body, Controller, Post, Query, Logger } from '@nestjs/common';
import axios from 'axios';
import { PaymentService } from './payment.service';
import { parseLydiaOrderRef } from './lydia-order-ref';
import {
  internalSocialRequestConfig,
  internalSubmissionUrl,
  productPurchaseCompletedUrl,
} from './social-internal-client';
import { describeHttpError } from '../common/http-error-log';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBMISSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/** Validates a submissionId before embedding in a URL path. */
function assertValidSubmissionId(submissionId: string): void {
  if (!SUBMISSION_ID_RE.test(submissionId)) {
    throw new Error(`Invalid submissionId: ${submissionId}`);
  }
}

@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(private readonly paymentService: PaymentService) {}

  /** Marks a form submission as paid via the internal social-service route. */
  private async markSubmissionPaidInternal(
    submissionId: string,
    sessionId?: string
  ): Promise<void> {
    assertValidSubmissionId(submissionId);
    await axios.post(
      internalSubmissionUrl(submissionId, 'mark-paid'),
      sessionId ? { sessionId } : {},
      {
        ...internalSocialRequestConfig(),
        timeout: 15_000,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
  }

  /**
   * Fulfills a boutique product purchase via the internal social-service route, from the Lydia
   * `request/do` confirm callback below.
   */
  private async notifyProductPurchaseCompleted(
    productId: string,
    userId: string,
    amountCents: number,
    paymentReference: string
  ): Promise<void> {
    if (!UUID_RE.test(productId)) {
      throw new Error(`Invalid productId: ${productId}`);
    }
    await axios.post(
      productPurchaseCompletedUrl(productId),
      { userId, amountCents, paymentIntentId: paymentReference },
      {
        ...internalSocialRequestConfig(),
        timeout: 15_000,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
    this.logger.log(`Product purchase completed: productId=${productId} userId=${userId}`);
  }

  /** Cancels a pending form submission via the internal social-service route. */
  private async cancelPendingSubmissionInternal(submissionId: string): Promise<void> {
    assertValidSubmissionId(submissionId);
    await axios.post(
      internalSubmissionUrl(submissionId, 'cancel-pending'),
      {},
      {
        ...internalSocialRequestConfig(),
        timeout: 15_000,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
  }

  /**
   * Receives a `confirm_url`/`cancel_url`/`expire_url` callback from Lydia's `request/do`
   * (registered per-request by `LydiaPaymentProvider.createCheckoutSession`, via the `outcome`
   * query param WE set - Lydia just POSTs to whichever URL it was given). This is the
   * AUTHORITATIVE confirmation path for a Lydia payment: the
   * buyer returning to `browser_success_url` is not guaranteed (Lydia is app-driven), so
   * fulfillment cannot depend on it alone.
   *
   * No guard: the signature check below stands in for the NginxAuthGuard this route cannot
   * carry (Lydia, not a signed-in user, is the caller).
   */
  @Post('lydia-request-callback')
  async handleLydiaRequestCallback(
    @Query('outcome') outcome: string,
    @Body() body: Record<string, unknown>
  ) {
    if (outcome !== 'confirm' && outcome !== 'cancel' && outcome !== 'expire') {
      throw new BadRequestException('Invalid outcome');
    }

    const requestId = String(body?.request_id ?? '');
    const amount = String(body?.amount ?? '');
    const currency = String(body?.currency ?? '');
    const orderRef = String(body?.order_ref ?? '');
    const vendorToken = String(body?.vendor_token ?? '');
    const signature = String(body?.sig ?? '');

    if (!requestId || !signature) {
      throw new BadRequestException('Missing request_id or sig');
    }

    const verified = this.paymentService.verifyLydiaRequestCallback(
      { request_id: requestId, amount, currency, order_ref: orderRef, vendor_token: vendorToken },
      signature
    );
    if (!verified) {
      this.logger.error(
        `Lydia request-callback: signature verification failed (outcome=${outcome})`
      );
      throw new BadRequestException('Invalid signature');
    }

    const ref = parseLydiaOrderRef(orderRef);
    if (!ref) {
      this.logger.warn(`Lydia request-callback: unrecognized order_ref (outcome=${outcome})`);
      return { received: true };
    }

    try {
      if (outcome === 'confirm') {
        if (ref.kind === 'form') {
          await this.markSubmissionPaidInternal(ref.submissionId, requestId);
          this.logger.log(`Marked submission ${ref.submissionId} as paid via Lydia request/do`);
        } else {
          const amountCents = Math.round(Number(amount) * 100);
          await this.notifyProductPurchaseCompleted(
            ref.productId,
            ref.userId,
            Number.isFinite(amountCents) ? amountCents : 0,
            requestId
          );
        }
      } else if (ref.kind === 'form') {
        // No pending row exists for a boutique purchase (unlike a form submission), so a
        // cancelled/expired Lydia request for one is simply never fulfilled - nothing to undo.
        await this.cancelPendingSubmissionInternal(ref.submissionId);
        this.logger.log(`Cancelled pending submission ${ref.submissionId} after Lydia ${outcome}`);
      }
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error(
        `Lydia request-callback: fan-out failed (outcome=${outcome})`,
        describeHttpError(error)
      );
      throw new BadRequestException('Failed to process callback');
    }

    return { received: true };
  }
}
