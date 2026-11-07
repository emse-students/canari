import { Log } from '$lib/utils/Log';
import { coreUrl } from '$lib/utils/apiUrl';

/**
 * THE ONE PLACE A USER'S AVATAR URL IS BUILT (docs/wiki/sessions.md, "The avatar token").
 *
 * `GET /api/users/:id/avatar` is asked by an `<img>` or a cache `fetch`, and neither carries the
 * access token: an `<img>` cannot send a header, and the refresh cookie is scoped to `/api/auth` (and
 * is dropped outright on `tauri://localhost`). So the viewer's proof travels IN THE URL, as `?t=`: the
 * avatar token core-service mints beside every access token, bound to this session and stable for a
 * UTC day. Every builder goes through {@link avatarUrl}; `avatarUrl.test.ts` fails if a raw
 * `/api/users/<id>/avatar` builder reappears anywhere in `src/`.
 *
 * A face's identity is its USER ID, never this URL: the token changes at least daily and at every
 * sign-in, so anything keyed by the URL would split one face into several (`userAvatarCache.ts` keys
 * by the id).
 */

/** The avatar token of the signed-in session, in memory only - like the access token it rides with. */
let avatarToken: string | null = null;

/**
 * Adopts the avatar token a sign-in or a refresh answered, or forgets it (`null`) when the session
 * ends. An answer WITHOUT one (an estate with no `AVATAR_TOKEN_SECRET`, or a server older than this
 * build) leaves the URLs unsigned, which the server still accepts in phase 1 and counts.
 *
 * @param token the `avatar_token` field of the answer, as received
 */
export function setAvatarToken(token: string | null | undefined): void {
  const next = typeof token === 'string' && token.length > 0 ? token : null;
  if (next === avatarToken) return;
  // Said on a CHANGE only - the token is stable for a day, so a refresh normally hands back the same.
  Log.d('AvatarUrl', next ? 'avatar token adopted' : 'avatar token cleared - avatar URLs unsigned');
  avatarToken = next;
}

/** One UTC day, the unit of the bucket an avatar token names. */
const DAY_MS = 86_400_000;

/** The token this session already said it would not send, so the line is said once per token. */
let staleSaid: string | null = null;

/**
 * The UTC day bucket `token` names - its middle part, `<sessionId>.<bucket>.<mac>` - or null when it
 * does not read as one.
 */
function tokenBucket(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !/^(?:0|[1-9][0-9]{0,9})$/.test(parts[1])) return null;
  return Number(parts[1]);
}

/**
 * The avatar token to send at `nowMs`, or null to send none. THE SERVER HONOURS YESTERDAY, TODAY AND
 * TOMORROW, so a token older than yesterday (a session that has not refreshed for a day: an app left
 * in the background, a laptop asleep) would only earn a 403 and a face drawn as initials. It is not
 * sent: the request goes unsigned, which phase 1 still answers, until the next refresh adopts a token
 * of today (docs/wiki/backlog.d/p2-avatar-urls-refuse-unsigned-requests.md says what phase 2 owes
 * this case).
 */
function usableToken(nowMs: number): string | null {
  if (!avatarToken) return null;
  const bucket = tokenBucket(avatarToken);
  if (bucket !== null && bucket >= Math.floor(nowMs / DAY_MS) - 1) return avatarToken;
  if (staleSaid !== avatarToken) {
    staleSaid = avatarToken;
    Log.i(
      'AvatarUrl',
      bucket === null
        ? 'avatar token unreadable - avatar URLs unsigned until the next refresh'
        : `avatar token of day ${bucket} is older than yesterday - avatar URLs unsigned until the next refresh`
    );
  }
  return null;
}

/**
 * The URL of `userId`'s avatar, carrying the viewer's avatar token when this session holds one
 * the server still honours. Absolute (`coreUrl()`), so it resolves the same from a browser tab and
 * from a native shell whose page origin serves no API.
 *
 * @param nowMs the instant the token's day is read against - passed by a test, never asserted
 */
export function avatarUrl(userId: string, nowMs: number = Date.now()): string {
  const base = `${coreUrl()}/api/users/${encodeURIComponent(userId)}/avatar`;
  const token = usableToken(nowMs);
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}
