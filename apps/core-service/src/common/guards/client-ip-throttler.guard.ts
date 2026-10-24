import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * A throttle counted per VISITOR address, not per hop - for the restore routes (WP-RESTORE-1), two
 * of which no session reaches.
 *
 * `ThrottlerGuard` keys on `req.ip`, and core-service is only reached through the nginx container, so
 * `req.ip` is that container for every request. nginx resolves the client itself and forwards it as
 * `X-Real-IP` (`location /api/auth`), the only address here that names a visitor. The same guard, for
 * the same reason, is chat-delivery-service's and social-service's (the services share no package).
 */
// Module-level rather than a field: `ThrottlerGuard` declares members of its own.
const logger = new Logger('ClientIpThrottlerGuard');

@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const visitor = req.headers?.['x-real-ip'];
    if (typeof visitor === 'string' && visitor.length > 0) return `ip:${visitor}`;
    // No header: the request did not come through nginx (a test, a local call). Counted on the
    // socket and said out loud, because in production it would mean one shared bucket.
    logger.warn(`[THROTTLE] no X-Real-IP on ${req.method} ${req.path}, keyed on the socket`);
    return `ip:${req.ip}`;
  }
}
