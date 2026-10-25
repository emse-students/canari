/**
 * THE ONE RULE FOR A 401 ON A REQUEST THAT CARRIED A BEARER: renew the token, send the SAME request
 * again ONCE, and let the CALLER say what a 401 on the renewed token means.
 *
 * WHY RESENDING IS SAFE, AND WHERE THAT PREMISE HOLDS. On `/api/mls/*` and on the routes `apiFetch`
 * and the media upload reach for a stale bearer, the 401 is the auth guard's answer about the BEARER,
 * given before any handler runs, so the request did nothing. That is a fact of TODAY's servers, not of
 * HTTP: social-service also answers 401 from inside handlers (an authorization refusal in its posts
 * routes), where it is an answer about the request and a resend is merely useless; and a handler-level
 * 401 added under `/api/mls` would make the commit's resend a second submission. The commit gate
 * answers a resubmission of bytes it accepted as `duplicate`, which keeps even that case safe there.
 *
 * The token is usually a stale copy: read before a long encryption (a media upload), or minted before
 * the access token expired while a commit waited for the MLS lock. `apiFetch` had this rule, the media
 * upload grew a second copy, and the MLS delivery API had none, so a commit answered 401 ended an Add
 * with the group left at its old epoch (TOK-1, 2026-10-25). This is the one copy.
 *
 * What it leaves its caller holding, by TYPE and never by message:
 * - the resend's answer, whatever its status other than 401 - for the caller to read;
 * - `refusedRenewed(answer)` when the renewed token is refused too. `apiFetch` and the upload answer
 *   `SessionExpiredError` (core's guard IS the session authority); the MLS delivery API answers a
 *   typed refusal that is never a logout, because its guard also answers 401 for its own faults;
 * - whatever the renewal threw, AS IT CAME: `refresh()` separates a dead cookie
 *   (`SessionExpiredError`), an answer that is not a verdict (`RefreshFailedError`), a sign-out under
 *   way, a split identity, and a transport failure that reached nobody (`isTransportFailure`) - unless
 *   the caller types it (`renewalFailed`), knowing the server answered 401 and the request did nothing;
 * - `refusedRenewed(first)` at once, with no renewal, for a token the guard already refused once
 *   renewed (`refusedTokens`);
 * - {@link TokenAccountChangedError} when the token to resend with names another account;
 * - the caller's `signal` reason when its deadline ran out during the renewal - the renewal is
 *   BOUNDED by the request it serves, never left to hold the caller past its own deadline.
 */

import { decodeTokenClaims } from '$lib/utils/jwtClaims';

/**
 * The token to resend with after a 401 names ANOTHER ACCOUNT than the refused one: a sign-in to a
 * different account landed between the request and its renewal. The request was built for the first
 * account (its body may name it), so it is NOT sent as the second - and this is not a logout either:
 * the session that now exists is the new one, alive. Decided on the two tokens' `sub`; a token that
 * does not decode proves nothing, and is not refused for it.
 */
export class TokenAccountChangedError extends Error {
  constructor(where: string) {
    super(`${where} was refused for one account and the token now names another - not sent again`);
    this.name = 'TokenAccountChangedError';
  }
}

/**
 * The renewed tokens a guard refused, so that NONE is renewed again: one per caller's latch, the
 * LATEST only - a different token (a renewal that worked, a sign-out and a new sign-in) replaces it,
 * which is what drops it. Durable for the token's life, never a clock: a guard refusing every renewed
 * token would otherwise rotate the session once per request.
 */
export class RefusedRenewedToken {
  private token: string | null = null;

  /** Whether `token` is the renewed token the guard last refused. */
  has(token: string): boolean {
    return this.token === token;
  }

  /** Latches `token` as refused although renewed. */
  add(token: string): void {
    this.token = token;
  }
}

/** What a 401 rule needs from its caller beyond the request itself. */
export interface RenewOn401Options<R> {
  /** The token in memory NOW (`getToken`): when it already differs from the refused one, it is used. */
  tokenNow: () => Promise<string>;
  /** Renews the access token (`refresh`, single-flight). */
  renew: () => Promise<string>;
  /** What a 401 on the renewed token is - see the module comment. */
  refusedRenewed: (answer: R) => Error | Promise<Error>;
  /** `METHOD /path` (no origin, no query), named in the log lines. */
  where: string;
  /** The caller's deadline: the renewal is abandoned with its reason when it aborts. */
  signal?: AbortSignal | null;
  /**
   * What a renewal failure becomes, typed at this throw where it is KNOWN that the server answered
   * 401 - so the request did nothing. Left out, the failure is rethrown as it came (`apiFetch`).
   */
  renewalFailed?: (error: unknown, where: string) => unknown;
  /** Renewed tokens a guard refused: a 401 on one answers `refusedRenewed` at once, never renews. */
  refusedTokens?: RefusedRenewedToken;
}

/** An answer with a status: a `Response`, or a reader's result that already consumed one. */
type Answered = { status: number };

/**
 * Releases an answer the caller will not read. `plugin-http` holds the connection until its body is
 * read or cancelled, so a 401 left unread costs a socket per renewal. A `Response` only, and only one
 * whose body nobody has started reading.
 */
async function discard(answer: Answered, where: string): Promise<void> {
  if (!(answer instanceof Response) || !answer.body || answer.bodyUsed) return;
  try {
    await answer.body.cancel();
  } catch (e) {
    console.warn(`[AUTH] the 401 body of ${where} could not be released: ${String(e)}`);
  }
}

/** `p`, or the signal's reason as soon as `signal` aborts - whichever comes first. */
function boundedBy<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // A late settlement after the abort is absorbed here: the outcome was already given.
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

/**
 * The token to resend with after `refused` was answered 401: the one in memory when another caller
 * already renewed it (the single flight only joins a renewal while it is PENDING, so a caller whose
 * 401 lands after it settled would otherwise rotate the session again), else a renewal.
 */
async function tokenAfter401<R>(refused: string, opts: RenewOn401Options<R>): Promise<string> {
  const now = await opts.tokenNow();
  if (now !== refused) {
    console.log(`[AUTH] ${opts.where}: the token was renewed meanwhile - sent again with it`);
    return now;
  }
  return opts.renew();
}

/** Whether both tokens decode to a `sub` and the two differ. */
function namesAnotherAccount(refused: string, next: string): boolean {
  const before = decodeTokenClaims(refused)?.sub;
  const after = decodeTokenClaims(next)?.sub;
  return !!before && !!after && before !== after;
}

/**
 * The 401 rule applied to an answer already in hand: `first` was the 401 to a request sent with
 * `token`; the token is renewed (bounded by `opts.signal`) and `send` runs ONCE more. For a caller
 * whose first request runs under a guard that must not cover the renewal (the pending pull's
 * page-halving ladder); everyone else calls {@link sendRenewingOn401}.
 */
export async function resendAfter401<R extends Answered>(
  first: R,
  send: (token: string) => Promise<R>,
  token: string,
  opts: RenewOn401Options<R>
): Promise<R> {
  // A TOKEN THE GUARD ALREADY REFUSED ONCE RENEWED IS NOT RENEWED AGAIN: the answer is known.
  if (opts.refusedTokens?.has(token)) {
    const refusal = await opts.refusedRenewed(first);
    await discard(first, opts.where);
    console.warn(
      `[AUTH] 401 on ${opts.where} with a token already refused once renewed - not renewed again: ${refusal.name}`
    );
    throw refusal;
  }
  // An EXPECTED line, not an accusation: an access token expiring between its read and its use is
  // ordinary. What would accuse - a renewal that fails, a renewed token refused - warns below.
  console.log(
    `[AUTH] 401 on ${opts.where} - renewing the token and sending the same request once more`
  );
  await discard(first, opts.where);
  let renewed: string;
  try {
    renewed = await boundedBy(tokenAfter401(token, opts), opts.signal);
  } catch (e) {
    const cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const abandoned = opts.signal?.aborted === true;
    const thrown = opts.renewalFailed ? opts.renewalFailed(e, opts.where) : e;
    console.warn(
      `[AUTH] token renewal ${abandoned ? 'abandoned at the request deadline' : 'failed'} after a 401 on ${opts.where} - ${cause}` +
        (thrown !== e && thrown instanceof Error
          ? ` - the request did nothing: ${thrown.name}`
          : '')
    );
    throw thrown;
  }
  if (namesAnotherAccount(token, renewed)) {
    const refusal = new TokenAccountChangedError(opts.where);
    console.warn(`[AUTH] ${refusal.message}`);
    throw refusal;
  }
  const retry = await send(renewed);
  if (retry.status === 401) {
    const refusal = await opts.refusedRenewed(retry);
    await discard(retry, opts.where);
    opts.refusedTokens?.add(renewed);
    console.warn(
      `[AUTH] 401 again on ${opts.where} with a renewed token - ${refusal.name}` +
        (opts.refusedTokens ? '; that token is not renewed again' : '')
    );
    throw refusal;
  }
  console.log(`[AUTH] ${retry.status} on ${opts.where} after the token renewal`);
  return retry;
}

/**
 * Sends a request with `token`, and on a 401 applies {@link resendAfter401}. `send` builds the WHOLE
 * request from the token it is given, so both attempts carry the same body.
 */
export async function sendRenewingOn401<R extends Answered>(
  send: (token: string) => Promise<R>,
  token: string,
  opts: RenewOn401Options<R>
): Promise<R> {
  const first = await send(token);
  return first.status === 401 ? resendAfter401(first, send, token, opts) : first;
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
export function describeRequest(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  return `${(init?.method ?? 'GET').toUpperCase()} ${path}`;
}

/**
 * `fetchImpl` obeying {@link sendRenewingOn401} for every request routed through it that carries a
 * bearer - the shape for an API class that builds its own headers and was handed a `fetch`
 * (`MlsDeliveryApi`). A request without a bearer passes through untouched: there is no credential
 * to renew, and its 401 is simply the answer.
 *
 * The resend reuses `init` (body, signal) with only the bearer replaced, and the renewal is bounded
 * by `init.signal`, so a caller's deadline (`trackedFetch`) bounds both attempts AND the renewal.
 */
export function renewingOn401(
  fetchImpl: typeof fetch,
  opts: Omit<RenewOn401Options<Response>, 'where' | 'signal' | 'refusedRenewed'> & {
    refusedRenewed: (answer: Response, where: string) => Error | Promise<Error>;
  }
): typeof fetch {
  const renewing = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const bearer = bearerOf(init?.headers);
    if (bearer === null || init === undefined) return fetchImpl(input, init);
    const where = describeRequest(input, init);
    return sendRenewingOn401(
      (token) => fetchImpl(input, token === bearer ? init : withBearer(init, token)),
      bearer,
      {
        ...opts,
        where,
        signal: init.signal,
        refusedRenewed: (answer) => opts.refusedRenewed(answer, where),
      }
    );
  };
  return renewing as typeof fetch;
}
