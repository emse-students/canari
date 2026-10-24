import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

/**
 * A throttle counted per ACCOUNT, for a route only a signed-in caller can use - the restore-key
 * registration routes (WP-RESTORE-1), which every Android start calls.
 *
 * Counting those per address would put a whole campus behind one NAT in one bucket, and an ordinary
 * morning of starts would be refused. The bucket is the subject of a VERIFIED access token, so a
 * caller cannot pick another account's bucket; a request without one is counted per visitor
 * address, exactly as {@link ClientIpThrottlerGuard}, and the route refuses it anyway.
 */
// Module-level rather than a field: `ThrottlerGuard` declares members of its own.
const logger = new Logger('AccountThrottlerGuard');

/** The subject of a verified ACCESS token in `Authorization`, or null. Never throws. */
export function verifiedAccessSubject(
  authorization: unknown,
  secret: string | undefined
): string | null {
  if (typeof authorization !== 'string' || !secret) return null;
  const token = authorization.split(' ').pop();
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
      sub?: string;
      type?: string;
    };
    // A refresh token is signed with the same key: it is not an access token.
    if (payload.type === 'refresh' || !payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

@Injectable()
export class AccountThrottlerGuard extends ClientIpThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const subject = verifiedAccessSubject(req.headers?.['authorization'], process.env.JWT_SECRET);
    if (subject) return `user:${subject}`;
    logger.debug(
      `[THROTTLE] no verified access token on ${req.method} ${req.path}, keyed per visitor`
    );
    return super.getTracker(req);
  }
}
