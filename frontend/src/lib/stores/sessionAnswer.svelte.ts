/**
 * Which account the SERVER has issued an access token to in this page's life, or `null`.
 *
 * WHY IT EXISTS (F2 of community-open-budget, 2026-10-14). The community listing is a REST call: it
 * needs an access token and nothing else, and it used to start on `isLoggedIn`, which flips only
 * once the PIN (or the vault) is through AND MLS is initialised - 650 ms after the token on the
 * Mi 9T at 1x, 1.9 s at 4x. This is the fact the listing really waits for, made reactive so the app
 * shell can start the listing the moment it holds.
 *
 * AN ANSWER, NOT A CACHE OF THE TOKEN. It is set when the server hands a token over (a refresh, the
 * OIDC callback, an externally supplied token) and cleared only by what DISPROVES the session: a
 * 401/403 on the refresh, or a sign-out. A transport failure, a 5xx or a token about to expire say
 * nothing about the session, so they leave it alone - otherwise every refresh would flicker it and
 * restart work that was right to run.
 */

let answeredFor = $state<string | null>(null);

/** The account the server last issued an access token to, or `null` since a sign-out or a 401. */
export function sessionAnsweredFor(): string | null {
  return answeredFor;
}

/** Records the account a token was just issued to, or `null` when the session was disproved. */
export function noteSessionAnswered(userId: string | null): void {
  answeredFor = userId;
}
