/**
 * THE ONE RULE FOR A 401 ON A REQUEST THAT CARRIED A BEARER: renew the token, send the SAME request
 * again ONCE, and only a 401 on the renewed token proves the session over.
 *
 * A 401 on a first-party request is the auth guard's answer about the BEARER, given before any
 * handler runs, so the request did nothing and resending it is safe - a POST included. The token is
 * usually a stale copy: read before a long encryption (a media upload), or minted before the access
 * token expired while a commit waited for the MLS lock. Ending the gesture on it was a defect three
 * times over, one implementation per caller: `apiFetch` had it, the media upload grew its own
 * (#1477's sibling, prod 2026-10-06), and the MLS delivery API had none, so a commit answered 401
 * ended an Add with the group left at its old epoch (TOK-1, 2026-10-25). This is the one copy.
 *
 * What it leaves its caller holding, by TYPE and never by message:
 * - the retry's response, whatever its status other than 401 - an answer for the caller to read;
 * - {@link SessionExpiredError} when the renewed token is refused too - the session really is over,
 *   and that type is what every logout path tests for;
 * - whatever the renewal threw, AS IT CAME: `refresh()` already separates a dead cookie
 *   (`SessionExpiredError`), an answer that is not a verdict (`RefreshFailedError`), a sign-out under
 *   way, a split identity, and a transport failure that reached nobody (`isTransportFailure`). The
 *   last is NOT a logout: the request got no answer, and its caller treats it as such.
 */

import { SessionExpiredError } from '$lib/stores/auth';

/**
 * Sends a request with `token`, and on a 401 renews the token through `renew` and sends it ONCE
 * more with the renewed one (see the module comment for what reaches the caller).
 *
 * `send` builds the WHOLE request from the token it is given, so both attempts carry the same body;
 * `where` (`POST /api/...`, no origin, no query) names the request in the log lines.
 */
export async function sendRenewingOn401(
  send: (token: string) => Promise<Response>,
  token: string,
  renew: () => Promise<string>,
  where: string
): Promise<Response> {
  const res = await send(token);
  if (res.status !== 401) return res;
  console.warn(
    `[AUTH] 401 on ${where} - renewing the token and sending the same request once more`
  );
  let renewed: string;
  try {
    renewed = await renew();
  } catch (e) {
    const cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.warn(`[AUTH] token renewal failed after a 401 on ${where} - ${cause}`);
    throw e;
  }
  const retry = await send(renewed);
  if (retry.status === 401) {
    // A FRESHLY MINTED access token was refused: nothing but the session being over explains it.
    console.warn(`[AUTH] 401 again on ${where} with a renewed token - session invalid`);
    throw new SessionExpiredError();
  }
  console.log(`[AUTH] ${retry.status} on ${where} after the token renewal`);
  return retry;
}

/** The bearer token a request's headers carry, or `null` when it carries none. */
function bearerOf(headers: HeadersInit | undefined): string | null {
  const value = headers === undefined ? null : new Headers(headers).get('Authorization');
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

/** `init` with its bearer replaced by `token`, every other header (and the body) unchanged. */
function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** `METHOD /path` of a request, without its origin or query - what the log lines name. */
function describeRequest(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  return `${(init?.method ?? 'GET').toUpperCase()} ${path}`;
}

/**
 * `fetchImpl` obeying {@link sendRenewingOn401} for every request that carries a bearer token - the
 * shape for an API class that builds its own headers and was handed a `fetch` (`MlsDeliveryApi`).
 *
 * A request without a bearer passes through untouched: there is no credential to renew, and its 401
 * is simply the answer. The retry reuses `init` (body, signal) with only the bearer replaced, so a
 * caller's deadline signal bounds both attempts and the renewal between them.
 */
export function renewingOn401(fetchImpl: typeof fetch, renew: () => Promise<string>): typeof fetch {
  const renewing = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const bearer = bearerOf(init?.headers);
    if (bearer === null || init === undefined) return fetchImpl(input, init);
    return sendRenewingOn401(
      (token) => fetchImpl(input, token === bearer ? init : withBearer(init, token)),
      bearer,
      renew,
      describeRequest(input, init)
    );
  };
  return renewing as typeof fetch;
}
