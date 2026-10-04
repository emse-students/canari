import { UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies the per-minute `X-Internal-Token` nginx mints for the signed-in user: an HMAC-SHA256 of
 * `<userId>:<epoch minute>` under `INTERNAL_SHARED_SECRET`. The current and the previous minute are
 * accepted, to tolerate clock skew. Throws `UnauthorizedException` on an absent or wrong token.
 *
 * WHY ONLY THIS IS SHARED. Three services refuse an unsigned caller three different ways - an
 * empty `x-user-id`, an unset `NODE_ENV`, `x-user-logged-in !== 'true'` - and which of those is
 * intended is a policy decision nobody has taken (backlog, "THREE SERVICES REFUSE AN UNSIGNED
 * CALLER"). The HMAC check inside them was three identical copies, so it is this one file, copied
 * byte for byte into `core-service`, `social-service` and `chat-delivery-service` because there is
 * no shared TypeScript package (`declared-duplicates.mjs` holds them together). Each guard keeps its
 * own policy and calls this for the signature.
 *
 * @param headers the request headers, read for `x-internal-token` only
 * @param userId the lowercased `x-user-id` the token must have been minted for
 * @param secret the trimmed `INTERNAL_SHARED_SECRET`
 */
export function verifyInternalToken(
  headers: Readonly<Record<string, unknown>>,
  userId: string,
  secret: string
): void {
  const raw = headers['x-internal-token'];
  const token = typeof raw === 'string' ? raw.trim() : undefined;
  if (!token) {
    throw new UnauthorizedException('Missing X-Internal-Token header');
  }
  const epochMinute = Math.floor(Date.now() / 60000);
  const valid = [epochMinute, epochMinute - 1].some((min) => {
    const expected = createHmac('sha256', secret).update(`${userId}:${min}`).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
  if (!valid) {
    throw new UnauthorizedException('Invalid X-Internal-Token');
  }
}
