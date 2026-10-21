import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { clientAddress } from '../client-address';

/**
 * A throttle counted per VISITOR, not per hop.
 *
 * `ThrottlerGuard` keys on `req.ip`, and this service is only ever reached through the nginx
 * container, so `req.ip` is that container for every request: a "20 per minute per IP" limit was
 * 20 per minute for the whole internet. The visitor is `clientAddress` - the `X-Real-IP` nginx
 * resolves and overwrites - the same address the public form's ceiling counts.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return clientAddress(req);
  }
}
