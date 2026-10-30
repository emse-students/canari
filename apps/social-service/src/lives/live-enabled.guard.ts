import { CanActivate, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { readLivesMode } from './lives-mode';

/**
 * THE DEPLOY LOCK OF THE LIVE FEATURE: `LIVE_ENABLED=true`, and nothing else, opens it.
 *
 * Rendered by `infrastructure/deploy/render-env.sh` from `env-manifest.tsv`: the literal `true` on
 * both estates since the production flip (owner, 2026-10-30); what closes lives on an estate is the
 * runtime kill switch below. An unset or misspelt value is OFF. Read on every request rather than at boot so a test can flip
 * it, and because the cost is one property read.
 *
 * It is ONE of two locks: the runtime kill switch `platform_config.lives_mode` ({@link LiveEnabledGuard},
 * `lives-mode.ts`) must say `on` as well.
 */
export function isLiveEnabled(): boolean {
  return process.env.LIVE_ENABLED === 'true';
}

/**
 * Answers 404 on every `/api/lives` route unless BOTH switches are open - the deploy lock
 * (`LIVE_ENABLED`) and the runtime kill switch (`platform_config.lives_mode`, read from the database
 * on every request, migration 015 in core-service) - the same answer as a route that does not exist,
 * which is what it is on that estate. The deploy lock is asked first, so a production that never
 * opened lives does not even read the database. Declared BEFORE the auth guard so a switched-off
 * estate says nothing more about the route to a signed-in caller than to anybody else.
 */
@Injectable()
export class LiveEnabledGuard implements CanActivate {
  private readonly logger = new Logger(LiveEnabledGuard.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async canActivate(): Promise<boolean> {
    if (!isLiveEnabled()) {
      this.logger.debug('[LIVE] a /lives route was called while LIVE_ENABLED is off - 404');
      throw new NotFoundException();
    }
    const mode = await readLivesMode(this.db.manager, this.logger);
    if (mode === 'on') return true;
    this.logger.debug('[LIVE] a /lives route was called while lives_mode is off - 404');
    throw new NotFoundException();
  }
}
