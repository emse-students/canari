import { ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { RefusalCode, refusalBody } from '../utils/refusal-codes';

// Module-level rather than a field: `ThrottlerGuard` declares members of its own.
const logger = new Logger('UserThrottlerGuard');

/**
 * A `ThrottlerGuard` that counts per USER rather than per address.
 *
 * Every request reaches this service through nginx, so the address the stock guard keys on is
 * nginx's and one quota would be shared by every reader of the estate - the first heavy user would
 * rate-limit everybody. The user id is what `HeaderAuthGuard` has just proven (the per-minute HMAC
 * covers `x-user-id`), so this guard MUST run after it: `@UseGuards(HeaderAuthGuard,
 * UserThrottlerGuard)`, in that order.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<string, string | undefined>;
    const userId = headers['x-user-id']?.trim().toLowerCase();
    // Unreachable behind HeaderAuthGuard, which refuses a request without one; if the order is ever
    // inverted the request is counted under one shared key, which is strict rather than open.
    return userId ? `user:${userId}` : 'user:unidentified';
  }

  /**
   * The refusal: said once in this service's log, then answered as a coded `429`
   * (`code: RATE_LIMITED`) carrying `retryAfterMs`, the wait the throttler computed.
   *
   * The wait travels in the BODY as well as the stock `Retry-After` header because a cross-origin
   * client (the native app's WebView) cannot read a header the response does not expose, and the
   * client's typed refusal is built from the body (`refusalFromResponse`). Without the log line a
   * refused user would leave a trace in nginx's access line alone, which names no route handler and
   * no limit. The user id is cut to its first eight characters, as every other line here does.
   */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    const retryAfterMs = Math.max(1, detail.timeToBlockExpire) * 1000;
    logger.warn(
      `[THROTTLE] REFUSED ${context.getClass().name}.${context.getHandler().name} ` +
        `tracker=${detail.tracker.slice(0, 13)} limit=${detail.limit}/${detail.ttl}ms ` +
        `hits=${detail.totalHits} retryAfterMs=${retryAfterMs}`
    );
    throw new HttpException(
      refusalBody(RefusalCode.RATE_LIMITED, 'too many requests, retry later', { retryAfterMs }),
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
}
