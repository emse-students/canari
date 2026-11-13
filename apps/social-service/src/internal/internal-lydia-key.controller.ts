import { Body, Controller, Header, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { AssociationsService } from '../associations/associations.service';
import type { HeldBusinessRole } from '../associations/lydia-account-bridge';
import { assertInternalSecret } from './internal-secret.util';

/**
 * The ONE place a Lydia Business private token leaves this service decrypted: to core-service, to
 * verify a `request/do` callback (`PaymentService.verifyLydiaRequestCallback`).
 *
 * Three walls, each sufficient on its own for a browser: the path is under `/api/internal/`, which
 * nginx does not route (no `location` matches it, so `location /` serves the app shell); the route
 * demands `X-Internal-Secret` (timing-safe, an empty secret refuses everything); and it answers
 * `no-store` so no cache on the way keeps a copy. The vendor token travels in the BODY, not the
 * path, so no access log records which Business was asked about. Nothing here logs the value.
 */
@Controller('internal/associations')
export class InternalLydiaKeyController {
  private readonly logger = new Logger(InternalLydiaKeyController.name);

  constructor(private readonly associationsService: AssociationsService) {}

  /**
   * `{ businessPrivateToken }`: the decrypted key of the Business `vendorToken` names - an
   * association's active one, or a bridge's standby one (the key of the historical account a
   * payment row names after the switch) - or null when none holds it with a key - the two cases answer the SAME, so even this internal
   * caller cannot enumerate which associations have a key without also holding the signature.
   */
  @Post('lydia-callback-key')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async lydiaCallbackKey(
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { vendorToken?: unknown }
  ): Promise<{ businessPrivateToken: string | null }> {
    assertInternalSecret(headerSecret);
    const vendorToken = typeof body?.vendorToken === 'string' ? body.vendorToken : '';
    const businessPrivateToken = await this.associationsService.lydiaCallbackKey(vendorToken);
    this.logger.debug(
      `[INTERNAL_LYDIA_KEY] lookup answered ${businessPrivateToken ? 'a key' : 'none'}`
    );
    return { businessPrivateToken };
  }

  /**
   * `{ associationId, onboardingComplete, role }` of the association holding `vendorToken` - `role`
   * says whether it is the ACTIVE Business or a bridge's `pending` / `retired` one
   * (lydia-account-bridge.ts) - all null when none does: for the log line of Lydia's unsigned
   * business webhook. A read only: no key, nothing written, and the caller decides nothing on it.
   */
  @Post('lydia-business-of-vendor-token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async lydiaBusinessOfVendorToken(
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { vendorToken?: unknown }
  ): Promise<{
    associationId: string | null;
    onboardingComplete: boolean | null;
    role: HeldBusinessRole | null;
  }> {
    assertInternalSecret(headerSecret);
    const vendorToken = typeof body?.vendorToken === 'string' ? body.vendorToken : '';
    const holder = await this.associationsService.lydiaBusinessOfVendorToken(vendorToken);
    this.logger.debug(
      `[INTERNAL_LYDIA_KEY] business lookup answered ${holder ? 'an association' : 'none'}`
    );
    return {
      associationId: holder?.associationId ?? null,
      onboardingComplete: holder?.onboardingComplete ?? null,
      role: holder?.role ?? null,
    };
  }
}
