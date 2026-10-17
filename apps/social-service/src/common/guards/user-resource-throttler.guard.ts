import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// Module-level rather than a field: `ThrottlerGuard` declares members of its own (see
// `ClientIpThrottlerGuard`).
const logger = new Logger('UserResourceThrottlerGuard');

/**
 * A throttle counted per SIGNED-IN USER AND PER RESOURCE: the `X-User-Id` nginx set after
 * authentication, plus the route's `:submissionId`. For a route each call of which spends the
 * PLATFORM's provider tokens (`confirm-payment` asks Lydia's `request/state`), so a loop - a stuck
 * tab, a script - cannot drive provider traffic, while two answers of one person, or two people,
 * never share a bucket. Only behind `NginxAuthGuard`, which guarantees the header.
 */
@Injectable()
export class UserResourceThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req.headers?.['x-user-id'];
    const resource = req.params?.submissionId ?? '';
    if (typeof userId === 'string' && userId.length > 0) return `${userId}:${resource}`;
    // NginxAuthGuard refuses a request without it first; reaching here means a guard order changed.
    logger.error(`[THROTTLE] no X-User-Id on ${req.method} ${req.url}, keyed on the socket`);
    return `${req.ip}:${resource}`;
  }
}
