import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * A throttle counted per VISITOR, not per hop.
 *
 * `ThrottlerGuard` keys on `req.ip`, and this service is only ever reached through the nginx
 * container, so `req.ip` is that container for every request: a "20 per minute per IP" limit was
 * 20 per minute for the whole internet. nginx resolves the client itself (`real_ip` from the host
 * proxy, 2026-09-30) and forwards it as `X-Real-IP`, which is the only address here that names a
 * person. The service port is not published, so no caller can reach it without going through that
 * nginx, which overwrites the header.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(ClientIpThrottlerGuard.name);

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const forwarded = req.headers?.['x-real-ip'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded;
    // No header means the request did not come through nginx - a test, or a local call. Counted
    // on the socket, and said out loud, because in production it would mean one shared bucket.
    this.logger.warn(`[THROTTLE] no X-Real-IP on ${req.method} ${req.url}, keyed on the socket`);
    return req.ip;
  }
}
