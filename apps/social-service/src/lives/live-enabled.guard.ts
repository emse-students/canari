import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { LIVE_CLIENT_VERSION_HEADER, liveClientVersionAllowed } from './live-client-version';
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

/** Metadata key of {@link LiveDeletionRight}. */
export const LIVE_DELETION_RIGHT = 'canari:live-deletion-right';

/**
 * Marks a route as A MEMBER'S RIGHT TO DELETE WHAT THEY PUBLISHED: it stays reachable while the
 * runtime kill switch `lives_mode` is off (owner, 2026-11-20, charter principle 1 - your messages
 * are yours). An operations switch must never decide whether the organiser can withdraw a replay.
 * The deploy lock and the client floor still apply: where lives were never opened there is nothing
 * to withdraw, and a build below the floor has no such control.
 */
export const LiveDeletionRight = () => SetMetadata(LIVE_DELETION_RIGHT, true);

/**
 * Answers 404 on every `/api/lives` route unless BOTH switches are open - the deploy lock
 * (`LIVE_ENABLED`) and the runtime kill switch (`platform_config.lives_mode`, read from the database
 * on every request, migration 015 in core-service) - the same answer as a route that does not exist,
 * which is what it is on that estate. The deploy lock is asked first, so a production that never
 * opened lives does not even read the database.
 *
 * A THIRD CONDITION, PER CLIENT: the request must name a build that reads today's answers
 * (`X-Canari-Client-Version` >= `LIVE_MIN_CLIENT_VERSION`, `live-client-version.ts`); an older build,
 * or one that names none, gets the SAME 404 - which `1.5.1`+ classify as `disabled` and handle
 * cleanly. This is why the global `minClientVersion` floor is NOT raised for lives. Declared BEFORE the auth guard so a switched-off
 * estate says nothing more about the route to a signed-in caller than to anybody else.
 */
@Injectable()
export class LiveEnabledGuard implements CanActivate {
  private readonly logger = new Logger(LiveEnabledGuard.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!isLiveEnabled()) {
      this.logger.debug('[LIVE] a /lives route was called while LIVE_ENABLED is off - 404');
      throw new NotFoundException();
    }
    const header = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers[
      LIVE_CLIENT_VERSION_HEADER
    ];
    if (!liveClientVersionAllowed(header)) {
      this.logger.debug(
        `[LIVE] a /lives route was called by a client below the lives floor (version header: ${String(header ?? 'absent')}) - 404`
      );
      throw new NotFoundException();
    }
    const handler = context.getHandler?.();
    if (handler && new Reflector().get<boolean>(LIVE_DELETION_RIGHT, handler) === true) {
      this.logger.debug('[LIVE] a deletion-right route is served whatever lives_mode says');
      return true;
    }
    const mode = await readLivesMode(this.db.manager, this.logger);
    if (mode === 'on') return true;
    this.logger.debug('[LIVE] a /lives route was called while lives_mode is off - 404');
    throw new NotFoundException();
  }
}
