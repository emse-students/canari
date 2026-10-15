import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Query,
  Logger,
  UseInterceptors,
} from '@nestjs/common';
import { NoFilesInterceptor } from '@nestjs/platform-express';
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

/** Multer limits for the public Lydia callback route: a few short text fields, never a file. */
export const LYDIA_CALLBACK_BODY_LIMITS = {
  fields: 16,
  fieldSize: 4096,
  parts: 16,
  files: 0,
} as const;

/** Most field names a refusal line carries, and the longest one: the sender decides every name. */
const LOGGED_FIELD_NAMES = 16;
const LOGGED_NAME_LENGTH = 32;

/**
 * The field NAMES of a refused body, safe to log: the sender controls them, so they are capped in
 * number and length and stripped of anything outside `[w.-]` (a newline in a key would forge a log
 * line). Names only, never a value.
 */
export function describeFieldNames(body: Record<string, unknown> | undefined): string {
  const names = Object.keys(body ?? {});
  const shown = names
    .slice(0, LOGGED_FIELD_NAMES)
    .map((name) => name.replace(/[^\w.-]/g, '').slice(0, LOGGED_NAME_LENGTH));
  return `${names.length} field(s)=[${shown.join(',')}]`;
}

/** The media type of a request, bounded and stripped like a field name (the header is the sender's too). */
export function describeContentType(contentType: string | undefined): string {
  const mediaType = (contentType ?? '')
    .split(';')[0]
    .toLowerCase()
    .replace(/[^\w/.+-]/g, '');
  return mediaType.slice(0, 48) || 'none';
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

  /**
   * Cancels a pending form submission via the internal social-service route, naming the request
   * Lydia reported (its numeric `request_id`): social-service applies it only if that is still the
   * row's current request, so the cancel of a request a retry replaced changes nothing.
   */
  private async cancelPendingSubmissionInternal(
    submissionId: string,
    requestId: string
  ): Promise<void> {
    assertValidSubmissionId(submissionId);
    await axios.post(
      internalSubmissionUrl(submissionId, 'cancel-pending'),
      { requestId },
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
  // Reads the text fields of a `multipart/form-data` body: the global parsers only know JSON and
  // urlencoded, and Lydia's two real callbacks of 2026-10-15 reached this route with NO field at all.
  // A body of any other type passes through untouched.
  // The route is PUBLIC and unauthenticated, so multer is bounded before it parses anything: Lydia's
  // callback carries about eight fields, and an unbounded parser would hold 20 000 fields or 60 x 1 MB
  // parts in memory for any caller.
  @UseInterceptors(NoFilesInterceptor({ limits: LYDIA_CALLBACK_BODY_LIMITS }))
  async handleLydiaRequestCallback(
    @Query('outcome') outcome: string,
    @Body() body: Record<string, unknown>,
    @Headers('content-type') contentType?: string
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
      // Names only, never values: what Lydia actually sent is the one fact that separates a body
      // type we do not parse from field names we do not know.
      this.logger.error(
        `Lydia request-callback refused: no request_id or sig (outcome=${outcome}, ` +
          `content-type=${describeContentType(contentType)}, ${describeFieldNames(body)})`
      );
      throw new BadRequestException('Missing request_id or sig');
    }

    // The field set we assume Lydia signed; its NAMES go in the failure line below, next to the
    // names actually received, so one refused callback says which set is wrong.
    const signedFields = {
      request_id: requestId,
      amount,
      currency,
      order_ref: orderRef,
      vendor_token: vendorToken,
    };
    const verified = this.paymentService.verifyLydiaRequestCallback(signedFields, signature);
    if (!verified) {
      this.logger.error(
        `Lydia request-callback: signature verification failed (outcome=${outcome}, ` +
          `content-type=${describeContentType(contentType)}, ${describeFieldNames(body)}, ` +
          `verified-over=[${Object.keys(signedFields).join(',')}])`
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
        await this.cancelPendingSubmissionInternal(ref.submissionId, requestId);
        this.logger.log(
          `Reported Lydia ${outcome} of request ${requestId} for submission ${ref.submissionId}`
        );
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
