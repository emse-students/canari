import { CanActivate, Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * THE SERVER-SIDE SWITCH OF THE LIVE FEATURE: `LIVE_ENABLED=true`, and nothing else, opens it.
 *
 * Rendered per estate by `infrastructure/deploy/render-env.sh` (`compute_live_enabled`): `true` on
 * dev, `false` on production, so a stable release reaches no live route whatever client calls it.
 * An unset or misspelt value is OFF. Read on every request rather than at boot so a test can flip
 * it, and because the cost is one property read.
 */
export function isLiveEnabled(): boolean {
  return process.env.LIVE_ENABLED === 'true';
}

/**
 * Answers 404 on every `/api/lives` route while the switch is off - the same answer as a route that
 * does not exist, which is what it is on that estate. Declared BEFORE the auth guard so a switched-off
 * estate says nothing more about the route to a signed-in caller than to anybody else.
 */
@Injectable()
export class LiveEnabledGuard implements CanActivate {
  private readonly logger = new Logger(LiveEnabledGuard.name);

  canActivate(): boolean {
    if (isLiveEnabled()) return true;
    this.logger.debug('[LIVE] a /lives route was called while LIVE_ENABLED is off - 404');
    throw new NotFoundException();
  }
}
