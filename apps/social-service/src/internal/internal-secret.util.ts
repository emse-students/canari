import { ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Throws ForbiddenException unless `headerSecret` matches the `INTERNAL_SECRET` env
 * var (timing-safe comparison). Shared by every social-service route that lives on the
 * nginx-exposed `/api/...` prefix but must only accept server-to-server calls from
 * core-service (Stripe/payment sync, account deletion). An empty/unset secret always
 * rejects, so a misconfigured deployment fails closed rather than open.
 */
export function assertInternalSecret(headerSecret: string | undefined): void {
  if (!isInternalSecret(headerSecret)) throw new ForbiddenException();
}

/** The same timing-safe check as a boolean, for a route that serves anyone and trusts one caller more. */
export function isInternalSecret(headerSecret: string | undefined): boolean {
  const expected = Buffer.from(process.env.INTERNAL_SECRET ?? '');
  const received = Buffer.from(headerSecret ?? '');
  return (
    expected.length !== 0 &&
    received.length === expected.length &&
    crypto.timingSafeEqual(expected, received)
  );
}
