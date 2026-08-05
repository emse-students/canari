import { ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Throws ForbiddenException unless `headerSecret` matches the `INTERNAL_SECRET` env var
 * (timing-safe). Mirrors the util of the same name in social-service and media-service: one
 * session-free, server-to-server credential, distinct from the per-user `X-Internal-Token` HMAC
 * that nginx mints - that one is bound to a user id, so computing one is impersonation rather
 * than authentication.
 *
 * An empty/unset secret matches nothing, so a misconfigured deployment fails closed.
 */
export function assertInternalSecret(headerSecret: string | undefined): void {
  const expected = Buffer.from(process.env.INTERNAL_SECRET ?? '');
  const received = Buffer.from(headerSecret ?? '');
  if (
    expected.length === 0 ||
    received.length !== expected.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    throw new ForbiddenException();
  }
}
