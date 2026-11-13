import {
  CLIENT_VERSION_HEADER,
  clientVersionAtLeast,
  clientVersionOf,
} from '../common/client-version';

/**
 * The header a client names its build in on every lives call. NO header carried the version before
 * this one (survey of 2026-10-31: `?clientVersion=` on `/auth/refresh` and the announcement only,
 * `deviceAppVersion` in a device-registration BODY, nothing on a request to social-service), so
 * the lives calls were the first to send it; the notifications read sends it too since `1.6.10`
 * (`common/client-version.ts`, the one comparison).
 */
export const LIVE_CLIENT_VERSION_HEADER = CLIENT_VERSION_HEADER;

/**
 * The first build that reads the lives answers as they are now (no `maxDurationMs`, no
 * `byteBudget`). A `1.5.1`-`1.5.3` sheet would print `NaN minutes` against them, and those builds
 * cannot be told apart from a current one by anything they send - which is exactly why they are
 * answered like a switched-off estate.
 */
export const LIVE_MIN_CLIENT_VERSION = '1.5.4';

/**
 * Whether a lives request comes from a build that may use them: the header says `1.5.4` or more.
 *
 * - **NO HEADER (or an unreadable one) IS REFUSED.** That is what every older build sends, so the
 *   absence IS the evidence; letting it through would let in exactly the clients being kept away.
 *   Every current client sends it (`live/api.ts`); a script (the rig) must name a version too.
 * - A pre-release suffix is ignored: `1.5.4-alpha.2` is a `1.5.4` build.
 */
export function liveClientVersionAllowed(header: string | string[] | undefined): boolean {
  return clientVersionAtLeast(clientVersionOf(header), LIVE_MIN_CLIENT_VERSION) === true;
}
