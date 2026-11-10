import { ExecutionContext, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { RefusalCode, refusalBody } from '../utils/refusal-codes';

/**
 * THE refusal of every throttler guard of this service: said once in the guard's log as a
 * `[THROTTLE] REFUSED` line, then answered as a coded `429` (`code: RATE_LIMITED`) carrying
 * `retryAfterMs`, the wait the throttler computed.
 *
 * One implementation so that no guard refuses in silence: without the line a refused caller would
 * leave a trace in nginx's access line alone, which names no route handler and no limit. The wait
 * travels in the BODY as well as the stock `Retry-After` header because a cross-origin client (the
 * native app's WebView) cannot read a header the response does not expose, and the client's typed
 * refusal is built from the body (`refusalFromResponse`). The tracker is cut to its first thirteen
 * characters (`user:` plus eight of the id, as every other line here prints an id).
 */
export function refuseThrottled(
  logger: Logger,
  context: ExecutionContext,
  detail: ThrottlerLimitDetail
): never {
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
