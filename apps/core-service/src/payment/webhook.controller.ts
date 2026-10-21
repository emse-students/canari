import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Query,
  Logger,
  ServiceUnavailableException,
  UseInterceptors,
} from '@nestjs/common';
import { NoFilesInterceptor } from '@nestjs/platform-express';
import axios from 'axios';
import { PaymentService } from './payment.service';
import type { LydiaCallbackVerdict } from './lydia-callback-verification';
import { parseLydiaOrderRef } from './lydia-order-ref';
import { internalSocialRequestConfig, internalSubmissionUrl } from './social-internal-client';
import { describeHttpError } from '../common/http-error-log';

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

  /**
   * Hands a VERIFIED confirm callback to social-service as a TRIGGER, never as the payment itself:
   * social-service checks the row's payee account is `vendorToken` (the Business whose key verified
   * the callback), then settles from the row's OWN stored request, read at Lydia
   * (`FormsService.confirmPaymentFromCallback`). Nothing of the callback's amount decides anything.
   */
  private async confirmSubmissionFromCallback(
    submissionId: string,
    vendorToken: string,
    requestId: string
  ): Promise<{ outcome?: string }> {
    assertValidSubmissionId(submissionId);
    const { data } = await axios.post<{ outcome?: string }>(
      internalSubmissionUrl(submissionId, 'provider-confirm'),
      { vendorToken, requestId },
      {
        ...internalSocialRequestConfig(),
        timeout: 30_000,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
    return data ?? {};
  }

  /**
   * Hands a VERIFIED cancel/expire callback to social-service as a trigger, naming the request
   * Lydia reported (its numeric `request_id`): social-service applies it only if that is still the
   * row's current request and the row's payee account is `vendorToken`, the Business whose key
   * verified the callback - and then only once Lydia, read server to server, says the row's own
   * request is closed (`cancelPendingSubmission`). Answers the state social-service read.
   */
  private async cancelPendingSubmissionInternal(
    submissionId: string,
    requestId: string,
    vendorToken: string
  ): Promise<{ outcome?: string }> {
    assertValidSubmissionId(submissionId);
    const { data } = await axios.post<{ outcome?: string }>(
      internalSubmissionUrl(submissionId, 'cancel-pending'),
      { requestId, vendorToken },
      {
        ...internalSocialRequestConfig(),
        // The same budget as a confirm: social-service reads the row's request at Lydia first.
        timeout: 30_000,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
    return data ?? {};
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
   * carry (Lydia, not a signed-in user, is the caller). It uses the BUSINESS private token of the
   * association whose `vendor_token` the callback names, over every received field but `sig`
   * (`verifyLydiaCallback`, measured 2026-10-16). An association with no key stored has its
   * callbacks refused, by design: the payer's return (`confirm-payment`) still confirms.
   *
   * EVERY verification failure is the SAME 400 `Invalid signature` - unknown association, no key,
   * wrong signature, unsignable body - so the route answers nothing about which associations hold
   * a key. The reason goes to the server log only. Failing to READ the key, or to apply a VERIFIED
   * callback (social-service unreachable, the row's request unreadable at Lydia), is a 503, the
   * status Lydia may retry: neither is a verdict about the callback.
   *
   * A verified `product:` confirm FULFILS NOTHING until a boutique checkout is a stored row (B3):
   * logged at ERROR and acknowledged (payments.md, "What confirms a payment").
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

    // A text field or ''. Never `String(value)`: a JSON body chooses its own types, and
    // `String({ toString: 1 })` throws - a 500 for any caller who sends one.
    const text = (name: string): string => {
      const value = body?.[name];
      return typeof value === 'string' ? value : '';
    };
    const requestId = text('request_id');
    const orderRef = text('order_ref');
    const signature = text('sig');

    if (!requestId || !signature) {
      // Names only, never values: what Lydia actually sent is the one fact that separates a body
      // type we do not parse from field names we do not know.
      this.logger.error(
        `Lydia request-callback refused: no request_id or sig (outcome=${outcome}, ` +
          `content-type=${describeContentType(contentType)}, ${describeFieldNames(body)})`
      );
      throw new BadRequestException('Missing request_id or sig');
    }

    let verdict: LydiaCallbackVerdict;
    try {
      verdict = await this.paymentService.verifyLydiaRequestCallback(body);
    } catch (err: unknown) {
      this.logger.error(
        `Lydia request-callback: could not read the Business key to verify with (outcome=${outcome})`,
        describeHttpError(err as Error)
      );
      throw new ServiceUnavailableException('Callback verification unavailable');
    }
    if (!verdict.verified) {
      this.logger.error(
        `Lydia request-callback: signature verification failed (outcome=${outcome}, ` +
          `reason=${verdict.reason}, content-type=${describeContentType(contentType)}, ` +
          `${describeFieldNames(body)})`
      );
      throw new BadRequestException('Invalid signature');
    }
    const verifiedVendorToken = verdict.vendorToken;

    const ref = parseLydiaOrderRef(orderRef);
    if (!ref) {
      this.logger.warn(`Lydia request-callback: unrecognized order_ref (outcome=${outcome})`);
      return { received: true };
    }

    try {
      if (outcome === 'confirm') {
        if (ref.kind === 'form') {
          const { outcome: settled } = await this.confirmSubmissionFromCallback(
            ref.submissionId,
            verifiedVendorToken,
            requestId
          );
          if (settled === 'unreadable') {
            // social-service could not read the row's request at Lydia: answering 2xx would tell
            // Lydia this confirm was handled when nothing was recorded, so it becomes the 503 below.
            throw new Error(`the row's request could not be read at Lydia`);
          }
          this.logger.log(
            `Lydia confirm of request ${requestId} for submission ${ref.submissionId}: ${settled ?? 'unknown'}`
          );
        } else {
          // REFUSED until a boutique checkout is a STORED row naming its request (lot B3). A
          // verified signature proves only that the Business's key signed it, and that key is
          // whatever its payout manager typed: settling from the callback would let that manager
          // grant any tag, fire any Cercle webhook and record any purchase, with no money moved.
          // A form settles from its own row; a product has none to settle from. Acknowledged
          // (2xx): no retry can change the answer, and the line names what a human must settle.
          this.logger.error(
            `Lydia confirm of request ${requestId} for product ${ref.productId} (user ` +
              `${ref.userId}) NOT fulfilled: a boutique checkout stores no row to settle from, ` +
              `so a callback alone fulfils nothing - settle it by hand`
          );
        }
      } else if (ref.kind === 'form') {
        // No pending row exists for a boutique purchase (unlike a form submission), so a
        // cancelled/expired Lydia request for one is simply never fulfilled - nothing to undo.
        // A trigger, like a confirm: social-service reads the row's own request at Lydia and
        // releases the seat only when Lydia says it is closed.
        const { outcome: read } = await this.cancelPendingSubmissionInternal(
          ref.submissionId,
          requestId,
          verifiedVendorToken
        );
        if (read === 'unreadable') {
          // Nothing was decided: a 2xx would tell Lydia this report was handled.
          throw new Error(`the row's request could not be read at Lydia`);
        }
        this.logger.log(
          `Lydia ${outcome} of request ${requestId} for submission ${ref.submissionId}: ${read ?? 'unknown'}`
        );
      }
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error(
        `Lydia request-callback: fan-out failed (outcome=${outcome})`,
        describeHttpError(error)
      );
      // 503, the status Lydia may retry: the callback was VERIFIED, so the failure is ours (social
      // unreachable, the row's request unreadable at Lydia), never a verdict about the callback.
      throw new ServiceUnavailableException('Failed to process callback');
    }

    return { received: true };
  }
}
