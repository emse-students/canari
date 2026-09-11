import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ClaimOutcome, LegacyCotisationService } from '../users/legacy-cotisation.service';
import { assertInternalSecret } from './internal-secret.util';

/** Identity core-service resolved from the identity provider, for one sign-in. */
interface ClaimRequestBody {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
}

/**
 * Claims the cotisations a legacy estate recorded for a user who is signing in.
 *
 * Internal-only: core-service owns the `users` table and sees every sign-in, while the tags live
 * here. Auth is the shared `X-Internal-Secret`, like every other route in this module.
 */
@Controller('internal/legacy-cotisations')
export class InternalLegacyCotisationsController {
  private readonly logger = new Logger(InternalLegacyCotisationsController.name);

  constructor(private readonly legacyCotisations: LegacyCotisationService) {}

  /**
   * Idempotent by construction: a claimed staging row matches nothing on the next call, so
   * core-service may call this on every sign-in without tracking whether it already has.
   */
  @Post('claim')
  @HttpCode(200)
  async claim(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: ClaimRequestBody
  ): Promise<ClaimOutcome> {
    assertInternalSecret(secret);
    const outcome = await this.legacyCotisations.claimFor({
      userId: body.userId,
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      promo: typeof body.promo === 'number' ? body.promo : null,
    });
    if (outcome.granted > 0 || outcome.failed > 0 || outcome.conflicts > 0) {
      this.logger.log(
        `[legacy] claim for ${body.userId.slice(0, 8)}: granted=${outcome.granted} ` +
          `alreadyHeld=${outcome.alreadyHeld} failed=${outcome.failed} conflicts=${outcome.conflicts}`
      );
    }
    return outcome;
  }
}
