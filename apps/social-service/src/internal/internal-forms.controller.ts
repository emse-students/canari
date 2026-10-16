import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { FormsService } from '../forms/forms.service';

/**
 * Internal form-submission endpoints for core-service (payment callbacks).
 * Protected by X-Internal-Secret - not exposed through nginx auth headers.
 *
 * There is no `mark-paid` here any more (2026-10-16): a callback is a TRIGGER, and what records a
 * payment is Lydia's own answer about the row's stored request (`provider-confirm`).
 */
@Controller('internal/forms')
export class InternalFormsController {
  private readonly logger = new Logger(InternalFormsController.name);
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor(private readonly formsService: FormsService) {}

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

  /** The Business a verified callback names: required, so no report reaches a row unchecked. */
  private vendorTokenOf(body: { vendorToken?: unknown } | undefined, route: string): string {
    const vendorToken = typeof body?.vendorToken === 'string' ? body.vendorToken : '';
    if (!vendorToken) {
      this.logger.warn(`[INTERNAL_FORMS] ${route} refused: no vendorToken`);
      throw new BadRequestException('vendorToken is required');
    }
    return vendorToken;
  }

  /**
   * A Lydia confirm callback core-service VERIFIED with the Business key of `vendorToken`: settles
   * the submission from its own stored request if that Business is its payee
   * (`FormsService.confirmPaymentFromCallback`). Answers `{ outcome }`.
   */
  @Post('submissions/:submissionId/provider-confirm')
  providerConfirm(
    @Param('submissionId') submissionId: string,
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { vendorToken?: unknown; requestId?: unknown }
  ) {
    this.assertInternalSecret(headerSecret);
    const vendorToken = this.vendorTokenOf(body, 'provider-confirm');
    this.logger.debug(`[INTERNAL_FORMS] provider-confirm submission ${submissionId}`);
    return this.formsService.confirmPaymentFromCallback(submissionId, {
      vendorToken,
      requestId: typeof body?.requestId === 'string' ? body.requestId : undefined,
    });
  }

  /**
   * Cancels a pending submission when ITS payment request expired or was cancelled. The body names
   * that request (`requestId`: Lydia's numeric id from a callback; `sessionId`: the request_uuid),
   * and a report about a request the row no longer uses changes nothing (`cancelPendingSubmission`),
   * nor does one whose `vendorToken` is not the row's payee.
   */
  @Post('submissions/:submissionId/cancel-pending')
  cancelPending(
    @Param('submissionId') submissionId: string,
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { requestId?: string; sessionId?: string; vendorToken?: unknown }
  ) {
    this.assertInternalSecret(headerSecret);
    const vendorToken = this.vendorTokenOf(body, 'cancel-pending');
    this.logger.debug(`[INTERNAL_FORMS] cancel-pending submission ${submissionId}`);
    return this.formsService.cancelPendingSubmission(
      submissionId,
      {
        requestId: typeof body?.requestId === 'string' ? body.requestId : undefined,
        sessionId: typeof body?.sessionId === 'string' ? body.sessionId : undefined,
      },
      vendorToken
    );
  }
}
