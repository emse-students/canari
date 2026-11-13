import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { refuseThrottled } from './throttle-refusal';

/**
 * A throttle counted per VISITOR address, not per hop - for a route no session reaches.
 *
 * `ThrottlerGuard` keys on `req.ip`, and this service is only reached through the nginx container,
 * so `req.ip` is that container for every request. nginx resolves the client itself (`real_ip`
 * from the host proxy) and forwards it as `X-Real-IP`, the only address here that names a visitor;
 * the service port is not published, so nothing reaches it without that nginx overwriting the
 * header. The same guard, for the same reason, is social-service's
 * `common/guards/client-ip-throttler.guard.ts` (the services share no package).
 *
 * The LAST of the three keys, for a route that proves no user at all: a session route counts per
 * user (`UserThrottlerGuard`, after `HeaderAuthGuard`), a shut phone's route per user too
 * (`PushSecretThrottlerGuard`, after `PushSecretGuard`), and only what carries neither counts per
 * address - the GIF relay, an `<img src>` with no session and no push secret. An address is a
 * weaker key than a user: every device behind one NAT shares it, so it is never chosen while a
 * proven user is available.
 */
// Module-level rather than a field: `ThrottlerGuard` declares members of its own.
const logger = new Logger('ClientIpThrottlerGuard');

@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  /** Refused out loud, as every throttler guard here: {@link refuseThrottled}. */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    refuseThrottled(logger, context, detail);
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const forwarded = req.headers?.['x-real-ip'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return `ip:${forwarded}`;
    // No header: the request did not come through nginx (a test, a local call). Counted on the
    // socket and said out loud, because in production it would mean one shared bucket.
    // The PATH only: the GIF relay's query names a GIF and carries a ticket.
    logger.warn(`[THROTTLE] no X-Real-IP on ${req.method} ${req.path}, keyed on the socket`);
    return `ip:${req.ip}`;
  }
}
