import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { refuseThrottled } from './throttle-refusal';

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

  /** Refused out loud, as every throttler guard here: {@link refuseThrottled}. */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    refuseThrottled(logger, context, detail);
  }
}
