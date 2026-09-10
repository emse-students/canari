/**
 * THE PURE HALF OF "WHO IS THIS CLIENT" - a token's subject, and what a disagreement means.
 *
 * Its own module for the reason `device-census.mjs`, `native-residue.mjs` and `usability.mjs` are:
 * `identity-selftest.mjs` runs in the CI gate, and the gate has no `names.mjs` and no browser.
 * Deciding what a subject MEANS needs neither.
 *
 * The rule these encode, written after the false P1 of 2026-09-09: a rig holds THREE strings for one
 * human - a login, a display name and a subject - and only the subject decides anything on the
 * server. See `accounts.mjs`'s `subjectFor`.
 */

/** The `sub` of a JWT, or null when absent or unparseable - never a throw. */
export function subjectOfToken(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).sub ?? null;
  } catch {
    return null;
  }
}

/**
 * An account key for a subject, or `unknown:<12 chars>`.
 *
 * CUT ON PURPOSE: a subject is a user id, and this output reaches a PUBLIC repository's logs. Twelve
 * characters distinguish the accounts a rig has without publishing one.
 */
export function nameSubject(sub, roleOf) {
  if (!sub) return null;
  return roleOf(sub) ?? `unknown:${String(sub).slice(0, 12)}`;
}

/**
 * What a client shows, what it acts as, and whether either is a fault.
 *
 * `agrees` is deliberately NOT the negation of a mismatch: an unreadable half is not an agreement,
 * so a client that has no token yet reads `agrees: false` rather than passing quietly. That is the
 * same conservatism `login.mjs` applies to `holdsASession` - a false negative costs one re-read, a
 * false positive costs the caller its measurement.
 */
export function describeIdentity({ saved, tokenSub, expected, roleOf }) {
  const shows = nameSubject(saved, roleOf);
  const actsAs = nameSubject(tokenSub, roleOf);
  return {
    shows,
    actsAs,
    agrees: Boolean(saved && tokenSub && saved === tokenSub),
    correct: actsAs !== null && actsAs === expected,
  };
}

/**
 * The rows that are WRONG - reachable, and acting as an account other than their owner.
 *
 * Unreachable clients are not faults: a row that does not use W3 does not care that W3 is closed. A
 * caller that NEEDS a client asserts its presence by asking for it.
 */
export const wrongIdentities = (rows) => rows.filter((r) => r.reachable && !r.correct);
