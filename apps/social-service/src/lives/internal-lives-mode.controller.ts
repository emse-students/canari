import { Controller, Get, Headers, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { assertInternalSecret } from '../internal/internal-secret.util';
import { readLivesMode, type LivesMode } from './lives-mode';

/**
 * The lives kill switch, relayed to media-service (`GET /api/internal/lives/mode`).
 *
 * media-service serves and stores live segments but has no database, so it cannot read
 * `platform_config.lives_mode` itself; it asks here on every live segment request that reaches it
 * (`LiveModeClient` in media-service). Answers the RAW mode, not the AND with `LIVE_ENABLED`:
 * media-service checks its own copy of that deploy lock first, so each lock is asked where it lives.
 *
 * Internal-only: nginx routes no `/api/internal/` path to social-service, and the route checks
 * `X-Internal-Secret` all the same. Deliberately NOT behind `LiveEnabledGuard` - it reports the
 * switch, it serves nothing live.
 */
@Controller('internal/lives')
export class InternalLivesModeController {
  private readonly logger = new Logger(InternalLivesModeController.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Get('mode')
  async mode(
    @Headers('x-internal-secret') secret: string | undefined
  ): Promise<{ mode: LivesMode }> {
    assertInternalSecret(secret);
    const mode = await readLivesMode(this.db.manager, this.logger);
    this.logger.debug(`[LIVE] lives_mode relayed to media-service: ${mode}`);
    return { mode };
  }
}
