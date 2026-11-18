/**
 * WHAT A SESSION'S TOKEN SOURCE ANSWERED INSTEAD OF A TOKEN, carried as a field on the error types it
 * throws (`SessionExpiredError` and its device-revocation subtype, `SignOutInProgressError`,
 * `IdentitySplitError`) and set at the throw.
 *
 * A field and not `instanceof`, for one reader: the push registration names this verdict in the
 * outcome it states to the server (`unauthorized:<cause>`), and the auth store that defines most of
 * these types imports the push service - so the service cannot import them back. A field is also not
 * a class NAME: renaming a type keeps its verdict, where a lookup keyed on `error.name` would have
 * turned it into `other` without a word (review of #3765).
 */
export type TokenVerdict = 'session-expired' | 'device-revoked' | 'signing-out' | 'identity-split';

const TOKEN_VERDICTS: ReadonlySet<string> = new Set<TokenVerdict>([
  'session-expired',
  'device-revoked',
  'signing-out',
  'identity-split',
]);

/** The verdict `error` carries, or null when it carries none (any other failure). */
export function tokenVerdictOf(error: unknown): TokenVerdict | null {
  if (typeof error !== 'object' || error === null || !('tokenVerdict' in error)) return null;
  const verdict = (error as { tokenVerdict: unknown }).tokenVerdict;
  return typeof verdict === 'string' && TOKEN_VERDICTS.has(verdict)
    ? (verdict as TokenVerdict)
    : null;
}
