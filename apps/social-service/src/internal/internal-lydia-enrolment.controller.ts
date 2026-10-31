import {
  BadRequestException,
  Body,
  ServiceUnavailableException,
  Controller,
  Header,
  Headers,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  AssociationsService,
  type LydiaResponsableView,
} from '../associations/associations.service';
import { ProductsService } from '../associations/products.service';
import { assertInternalSecret } from './internal-secret.util';

/** What a `vendor_token` may look like before it is used for a lookup: printable ASCII, bounded. */
const VENDOR_TOKEN_SHAPE = /^[\x21-\x7e]{1,256}$/;

/**
 * The internal routes of Lydia enrolment lot 2, called by core-service only (docs/wiki/frontend/
 * modules/payments.md). Under `/api/internal/`, which nginx does not route, `X-Internal-Secret`
 * guarded (timing-safe) and `no-store`. A vendor token and a phone travel in the BODY, never the
 * path, so no access log records them; nothing here logs a phone.
 */
@Controller('internal/associations')
export class InternalLydiaEnrolmentController {
  private readonly logger = new Logger(InternalLydiaEnrolmentController.name);

  constructor(
    private readonly associationsService: AssociationsService,
    private readonly productsService: ProductsService
  ) {}

  /**
   * Lydia's UNSIGNED `BUSINESS_VALIDATED`, handed over by core-service: marks the holder of
   * `vendorToken` ready (`ProductsService.markLydiaReady`, cause `webhook-validated`; the risk of an
   * unsigned VALIDATED was accepted by the owner on 2026-10-30). ONLY `ready: true` with that cause
   * is accepted: `BUSINESS_UNVALIDATED` never changes state (decided 2026-10-30), so no body can
   * make this route turn an association NOT ready, nor clear what Lydia itself reported
   * (`held-by-lydia`, a 200 that wrote nothing). Answers what happened; no holder is `no-holder`, a
   * 200 - nothing to retry - EXCEPT while some association's `business/create` outcome is not yet
   * recorded (`no-holder-enrolment-in-flight`): the VALIDATED may name the Business being linked,
   * so this answers 503 and core answers Lydia 503, asking for a retry. That Lydia retries a 503 is
   * UNMEASURED. A failure to apply throws (5xx) the same way.
   */
  @Post('lydia-readiness')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async lydiaReadiness(
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { vendorToken?: unknown; ready?: unknown; cause?: unknown }
  ): Promise<{
    outcome: 'transitioned' | 'replay' | 'held-by-lydia' | 'no-holder';
    associationId: string | null;
  }> {
    assertInternalSecret(headerSecret);
    const vendorToken = typeof body?.vendorToken === 'string' ? body.vendorToken : '';
    if (
      !VENDOR_TOKEN_SHAPE.test(vendorToken) ||
      body?.ready !== true ||
      body?.cause !== 'webhook-validated'
    ) {
      this.logger.warn('[LYDIA-READINESS] internal readiness refused: malformed body');
      throw new BadRequestException('Only {vendorToken, ready: true, cause: webhook-validated}');
    }
    const outcome = await this.productsService.markLydiaReady(vendorToken, 'webhook-validated', {
      path: 'webhook',
    });
    if (outcome.kind === 'no-holder-enrolment-in-flight') {
      // A retry is asked for; whether Lydia honours a 503 is unmeasured.
      throw new ServiceUnavailableException('An enrolment is in flight; retry later');
    }
    if (!('associationId' in outcome)) return { outcome: 'no-holder', associationId: null };
    return { outcome: outcome.kind, associationId: outcome.associationId };
  }

  /** Claims the enrolment-in-flight marker before `business/create` (typed 409 otherwise). */
  @Post(':id/lydia-enrolment-claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async claimEnrolment(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<{ ok: true }> {
    assertInternalSecret(headerSecret);
    await this.associationsService.claimLydiaEnrolment(id);
    return { ok: true };
  }

  /**
   * Clears the enrolment-in-flight marker: `why: refused` after a typed refusal of `business/create`,
   * `why: admin` when a global admin checked with Lydia (core-service checks the admin).
   */
  @Post(':id/lydia-enrolment-release')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async releaseEnrolment(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { why?: unknown }
  ): Promise<{ ok: true }> {
    assertInternalSecret(headerSecret);
    if (body?.why !== 'refused' && body?.why !== 'admin') {
      throw new BadRequestException('why must be refused or admin');
    }
    await this.associationsService.releaseLydiaEnrolment(id, body.why);
    return { ok: true };
  }

  /**
   * What core-service checks before asking Lydia to add a Responsable, and the claim of that step
   * (`AssociationsService.claimLydiaResponsable`; typed 409 when another step is in flight). The
   * phone travels in the body and is never logged.
   */
  @Post(':id/lydia-responsable-claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async responsableClaim(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { userId?: unknown; phone?: unknown }
  ): Promise<{
    vendorToken: string | null;
    member: boolean;
    currentUserId: string | null;
    phoneMatches: boolean;
    claimed: boolean;
  }> {
    assertInternalSecret(headerSecret);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (!userId || !phone) throw new BadRequestException('userId and phone are required');
    return this.associationsService.claimLydiaResponsable(id, userId, phone);
  }

  /** Releases the Responsable step's claim after a typed outcome core-service knows. */
  @Post(':id/lydia-responsable-release')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async responsableRelease(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<{ ok: true }> {
    assertInternalSecret(headerSecret);
    await this.associationsService.releaseLydiaResponsable(id);
    return { ok: true };
  }

  /** Records the Responsable Lydia confirmed (sealed phone; only its last two digits answered). */
  @Post(':id/lydia-responsable')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async recordResponsable(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      vendorToken?: unknown;
      userId?: unknown;
      phone?: unknown;
      addedByUserId?: unknown;
    }
  ): Promise<{ responsable: LydiaResponsableView }> {
    assertInternalSecret(headerSecret);
    const responsable = await this.associationsService.recordLydiaResponsable(id, {
      vendorToken: body?.vendorToken,
      userId: body?.userId,
      phone: body?.phone,
      addedByUserId: body?.addedByUserId,
    });
    return { responsable };
  }
}
