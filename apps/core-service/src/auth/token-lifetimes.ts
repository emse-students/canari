/**
 * How long an access token this service signs stays valid, in seconds.
 *
 * ONE NUMBER, BECAUSE TWO THINGS DEPEND ON IT AGREEING: the `expiresIn` of every access token, and
 * the account erasure's final pass (`account-erasure.service.ts`), which waits until every token
 * issued before an account was deactivated has expired - the last moment a request could still act
 * as that account - and erases once more. A token that outlived this number would be a window the
 * erasure no longer covers.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Seconds added to {@link ACCESS_TOKEN_TTL_SECONDS} before a final pass that must run only once every
 * token issued before a moment has expired, for clock skew between the hosts. Shared by the account
 * erasure's final pass and the push-ending outbox's (`session-push-end.service.ts`).
 */
export const CREDENTIAL_SKEW_SECONDS = 120;
