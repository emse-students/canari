import { Controller, Get, Headers, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { assertInternalSecret } from './internal-secret.util';
import { readRetentionDays, type RetentionDays } from '../common/retention-settings';

/**
 * The retention durations, relayed to media-service (`GET /api/internal/retention`).
 *
 * media-service stamps the due time of a conversation's reel and the idle window of a conversation's
 * file at their upload, but has no database, so it cannot read `platform_config.retention_*` itself;
 * it asks here at each such upload, as it asks `internal/lives/mode` for the lives switch.
 *
 * Internal-only: nginx routes no `/api/internal/` path to social-service, and the route checks
 * `X-Internal-Secret` all the same.
 */
@Controller('internal/retention')
export class InternalRetentionController {
  private readonly logger = new Logger(InternalRetentionController.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Get()
  async retention(
    @Headers('x-internal-secret') secret: string | undefined
  ): Promise<RetentionDays> {
    assertInternalSecret(secret);
    const days = await readRetentionDays(this.db.manager, this.logger);
    this.logger.debug(
      `[RETENTION] relayed to media-service: chatReel=${days.chatReelDays} idleMedia=${days.idleMediaDays}`
    );
    return days;
  }
}
