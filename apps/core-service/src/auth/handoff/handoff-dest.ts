/**
 * WHICH PATH A SIGN-IN HANDOFF MAY LAND ON - one rule, two byte-identical copies: core-service's
 * (`apps/core-service/src/auth/handoff/handoff-dest.ts`), which refuses a mint for any other `dest`,
 * and the client's (`frontend/src/lib/navigation/handoffDest.ts`), which hands off a link tapped in
 * a message only for such a path and passes no other path to a site's sign-in entry. Declared in
 * `.github/scripts/lib/declared-duplicates.mjs`; its cases are `libs/contracts/handoff-dest.cases.json`,
 * which both sides' specs run. Imports nothing, which is what lets the copies be identical.
 */

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The pattern of `allowed` that `dest` matches exactly, segment by segment, `{uuid}` matching one
 * lowercase UUID - or null. No normalisation: a query, a fragment, a trailing slash, `..` or a
 * doubled slash is simply not on the list. The pattern, not the path, is what a log line may name:
 * `/albums/{uuid}` says where a handoff landed without saying which album.
 */
export function destPattern(dest: string, allowed: readonly string[]): string | null {
  if (!dest.startsWith('/')) return null;
  const parts = dest.split('/');
  const found = allowed.find((pattern) => {
    const want = pattern.split('/');
    if (want.length !== parts.length) return false;
    return want.every((seg, i) =>
      seg === '{uuid}' ? UUID_SEGMENT.test(parts[i]) : seg === parts[i]
    );
  });
  return found ?? null;
}

/** Whether `dest` is exactly one of `allowed` ({@link destPattern}). */
export function destIsAllowed(dest: string, allowed: readonly string[]): boolean {
  return destPattern(dest, allowed) !== null;
}
