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

/**
 * The URL of `userId`'s avatar, carrying the viewer's avatar token when this session holds one.
 * Absolute (`coreUrl()`), so it resolves the same from a browser tab and from a native shell whose
 * page origin serves no API.
 */
export function avatarUrl(userId: string): string {
  const base = `${coreUrl()}/api/users/${encodeURIComponent(userId)}/avatar`;
  return avatarToken ? `${base}?t=${encodeURIComponent(avatarToken)}` : base;
}
