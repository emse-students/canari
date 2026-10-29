/**
 * A service this process asked and could not get an ANSWER from: the connection failed, the budget
 * ran out, or the service answered 5xx, 408 or 429 - statuses that say nothing about the thing
 * asked for. Typed so the head injector can tell it apart from a REFUSAL (a 4xx, which is the
 * service answering "no such post"), and so that distinction is made where it is known - at the
 * throw - rather than recovered later from a message.
 *
 * Kept in a module of its own because `internalApi.ts` reads `$app/env/private` and so cannot
 * be imported where only the type is wanted.
 */
export class UpstreamUnavailableError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(`${url}: ${reason}`);
    this.name = 'UpstreamUnavailableError';
  }
}

/** Budget for one enrichment call. An unfurler gives up long before a user would. */
export const FETCH_TIMEOUT_MS = 1500;

/**
 * GETs JSON with a hard timeout, telling a REFUSAL from an UNAVAILABLE service.
 *
 * - 2xx: the parsed body;
 * - any other 4xx (not 408/429): `null`, logged. The service answered, and its answer is "not for you" or "no such thing" -
 *   a preview that stays generic and may be cached like any other answer;
 * - anything else (a transport failure, the timeout, a 5xx, a 408 or 429, an unreadable body): throws
 *   {@link UpstreamUnavailableError}. No answer was given, so nothing about the thing asked for is
 *   known, and the caller must not store the absence as if it were one.
 */
export async function fetchJsonOrThrow<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: abort.signal });
    // 408 and 429 are 4xx by number and transient by meaning: the service did not ANSWER about the
    // thing asked for, it asked to be asked again. They are unavailability, never a cached refusal.
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      throw new UpstreamUnavailableError(url, `answered ${res.status}`);
    }
    if (!res.ok) {
      console.log(`[SEO] ${url} answered ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) throw err;
    // `fetch` reports every transport failure as a bare TypeError; the diagnosis is in `cause`.
    const cause = (err as Error)?.cause;
    const detail = cause ? ` (${String((cause as Error)?.message ?? cause)})` : '';
    throw new UpstreamUnavailableError(url, `${(err as Error)?.message ?? 'failed'}${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

/** GETs JSON with a hard timeout. Returns null on any failure, logging the cause. */
export async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T | null> {
  try {
    return await fetchJsonOrThrow<T>(url, headers, timeoutMs);
  } catch (err) {
    console.log(`[SEO] ${url} failed:`, (err as Error)?.message);
    return null;
  }
}

/** Read by nginx into the access log (`deg=`), so a degraded card is countable from the log alone. */
export const DEGRADED_HEADER = 'X-Canari-Degraded';

/**
 * The headers of a page served from a head whose enrichment got no answer: `no-store`, so no cache
 * between this process and an unfurler keeps the generic card, and the marker nginx logs.
 */
export function degradedHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', [DEGRADED_HEADER]: '1' };
}
