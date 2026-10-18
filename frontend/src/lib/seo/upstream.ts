/**
 * A service this process asked and could not get an ANSWER from: the connection failed, the budget
 * ran out, or the service answered with a 5xx - the one status that says nothing about the thing
 * asked for. Typed so the head injector can tell it apart from a REFUSAL (a 4xx, which is the
 * service answering "no such post"), and so that distinction is made where it is known - at the
 * throw - rather than recovered later from a message.
 *
 * Kept in a module of its own because `internalApi.ts` reads `$env/dynamic/private` and so cannot
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

/** Read by nginx into the access log (`deg=`), so a degraded card is countable from the log alone. */
export const DEGRADED_HEADER = 'X-Canari-Degraded';

/**
 * The headers of a page served from a head whose enrichment got no answer: `no-store`, so no cache
 * between this process and an unfurler keeps the generic card, and the marker nginx logs.
 */
export function degradedHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', [DEGRADED_HEADER]: '1' };
}
