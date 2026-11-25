/**
 * WHICH PATH A SIGN-IN HANDOFF MAY LAND ON - one rule, two byte-identical copies: core-service's
 * (`apps/core-service/src/auth/handoff/handoff-dest.ts`), which refuses a mint for any other `dest`,
 * and the client's (`frontend/src/lib/navigation/handoffDest.ts`), which hands off a link tapped in
 * a message only for such a path and passes no other path to a site's sign-in entry. Declared in
 * `.github/scripts/lib/declared-duplicates.mjs`; its cases are `libs/contracts/handoff-dest.cases.json`.
 * Imports nothing, which is what lets the copies be identical.
 */

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether `dest` is exactly one of `allowed`, segment by segment, `{uuid}` matching one lowercase
 * UUID. No normalisation: a query, a fragment, a trailing slash, `..` or a doubled slash is simply
 * not on the list.
 */
export function destIsAllowed(dest: string, allowed: readonly string[]): boolean {
  if (!dest.startsWith('/')) return false;
  const parts = dest.split('/');
  return allowed.some((pattern) => {
    const want = pattern.split('/');
    if (want.length !== parts.length) return false;
    return want.every((seg, i) =>
      seg === '{uuid}' ? UUID_SEGMENT.test(parts[i]) : seg === parts[i]
    );
  });
}
