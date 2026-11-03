import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSessionsService } from '../auth/auth-sessions.service';
import { checkAvatarTokenSignature, type AvatarTokenRefusal } from '../auth/avatar-token';
import { assertInternalSecret } from '../internal/internal-secret.util';

/**
 * Who is asking `GET /users/:id/avatar`, decided ONCE per request (docs/wiki/sessions.md, "The
 * avatar token").
 *
 * - `internal` - a service of this estate, proven by `x-internal-secret` (`INTERNAL_SECRET`, the
 *   credential every service-to-service call to core already carries). EXEMPT from the avatar token:
 *   chat-delivery's notification face (`GET /api/mls/push/avatar/:id`) and social-service's public
 *   roster relay ask on behalf of a caller they have authenticated themselves, and no viewer session
 *   exists to sign for. The exemption is a CREDENTIAL, never a network position: a request is not
 *   exempt for arriving from inside the Docker network, only for proving it is a service.
 * - `signed` - a viewer whose `?t=` token verifies and whose session is live.
 * - `unsigned` - no token at all. PHASE 1: accepted, and logged by the caller as `[AVATAR] ...
 *   access=unsigned via=... origin=...`, so the population of builds that do not send one yet is
 *   measured before phase 2 refuses it (docs/wiki/backlog.d/p2-avatar-urls-refuse-unsigned-requests.md).
 * - `refused` - a credential WAS presented and is wrong: a bad internal secret, or a token that is
 *   malformed, not signed by this server (`bad-signature`), signed for a day it no longer honours
 *   (`stale`), or names a session that has ended.
 */
export type AvatarAccess =
  | { readonly kind: 'internal' }
  | { readonly kind: 'signed' }
  | { readonly kind: 'unsigned' }
  | {
      readonly kind: 'refused';
      readonly reason: AvatarTokenRefusal | 'bad-internal-secret';
    };

/**
 * Classifies one avatar request - see {@link AvatarAccess}. Reads the internal secret first (a
 * service never carries a viewer token), then the `t` query parameter. Never throws.
 *
 * @param req the request, read for `x-internal-secret` and `query.t` only
 * @param sessions the session store, asked only once a token's signature holds
 * @param now the instant the token's day bucket and the session's expiry are read against
 */
export async function avatarAccessOf(
  req: Pick<Request, 'headers' | 'query'>,
  sessions: Pick<AuthSessionsService, 'isLiveSession'>,
  now: Date = new Date()
): Promise<AvatarAccess> {
  const secretHeader = req.headers['x-internal-secret'];
  if (secretHeader !== undefined) {
    try {
      assertInternalSecret(typeof secretHeader === 'string' ? secretHeader : undefined);
      return { kind: 'internal' };
    } catch (e) {
      // CLASSIFIED BY TYPE: `ForbiddenException` is the util's one refusal; anything else is a defect.
      if (e instanceof ForbiddenException)
        return { kind: 'refused', reason: 'bad-internal-secret' };
      throw e;
    }
  }

  const token = req.query?.t;
  if (token === undefined) return { kind: 'unsigned' };
  // `?t=a&t=b` arrives as an array: a URL this client never builds, so it is no token at all.
  if (typeof token !== 'string') return { kind: 'refused', reason: 'malformed' };

  const signature = checkAvatarTokenSignature(token, now.getTime());
  if (!signature.ok) return { kind: 'refused', reason: signature.reason };
  // THE DURABLE HALF: a perfectly signed token of an ended session is refused.
  if (!(await sessions.isLiveSession(signature.sessionId, now))) {
    return { kind: 'refused', reason: 'session-ended' };
  }
  return { kind: 'signed' };
}
