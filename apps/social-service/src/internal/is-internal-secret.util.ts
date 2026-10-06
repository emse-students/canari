import * as crypto from 'crypto';

/**
 * Boolean form of the `INTERNAL_SECRET` check, for a PUBLIC route that serves anyone and trusts one
 * caller more (the agenda feed, which skips its signature for the SEO page). Kept apart from
 * `assertInternalSecret`, whose body is a declared duplicate across services
 * (`declared-duplicates.test.mjs`). An empty or unset secret never matches.
 */
export function isInternalSecret(headerSecret: string | undefined): boolean {
  const expected = Buffer.from(process.env.INTERNAL_SECRET ?? '');
  const received = Buffer.from(headerSecret ?? '');
  return (
    expected.length !== 0 &&
    received.length === expected.length &&
    crypto.timingSafeEqual(expected, received)
  );
}
