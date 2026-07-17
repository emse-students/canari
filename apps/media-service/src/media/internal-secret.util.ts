import { ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Throws ForbiddenException unless `headerSecret` matches the `INTERNAL_SECRET` env
 * var (timing-safe comparison). Gates the blob-deletion route: `DELETE /media/:id`
 * lives on the nginx-exposed `/api/media` prefix, but the only legitimate caller is
 * social-service tidying up replaced association logos / event images / form banners /
 * documents (server-to-server on the Docker network). Requiring the shared secret blocks
 * a logged-in client from enumerating public media ids and deleting other associations'
 * assets. Mirrors social-service's `assertInternalSecret`. An empty/unset secret always
 * rejects, so a misconfigured deployment fails closed rather than open.
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
