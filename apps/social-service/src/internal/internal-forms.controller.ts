import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { FormsService } from '../forms/forms.service';

/**
 * Internal form-submission endpoints for core-service (charge-saved-method, webhooks).
 * Protected by X-Internal-Secret - not exposed through nginx auth headers.
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

  /** Returns submission payment details for charge-saved-method. */
  @Get('submissions/:submissionId')
  getSubmission(
    @Param('submissionId') submissionId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    this.assertInternalSecret(headerSecret);
    this.logger.debug(`[INTERNAL_FORMS] get submission ${submissionId}`);
    return this.formsService.getSubmissionById(submissionId);
  }

  /** Marks a submission as paid after Stripe confirms payment. */
  @Post('submissions/:submissionId/mark-paid')
  markPaid(
    @Param('submissionId') submissionId: string,
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { sessionId?: string }
  ) {
    this.assertInternalSecret(headerSecret);
    this.logger.debug(`[INTERNAL_FORMS] mark-paid submission ${submissionId}`);
    return this.formsService.markPaid(submissionId, body.sessionId);
  }

  /** Cancels a pending submission when checkout expires or a charge fails. */
  @Post('submissions/:submissionId/cancel-pending')
  cancelPending(
    @Param('submissionId') submissionId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    this.assertInternalSecret(headerSecret);
    this.logger.debug(`[INTERNAL_FORMS] cancel-pending submission ${submissionId}`);
    return this.formsService.cancelPendingSubmission(submissionId);
  }
}
