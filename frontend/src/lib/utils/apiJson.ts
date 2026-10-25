/**
 * A 2xx THAT IS NOT THE API'S JSON DID NOT COME FROM THE API.
 *
 * Every first-party endpoint this client reads answers a JSON body with a JSON content type (Nest
 * serialises what a handler returns as `application/json`). A captive portal, a hotel or campus
 * login page, a proxy that rewrites traffic: each can answer ANY request with `200 text/html`, and
 * that `200` is not the server's verdict on the request - the request never reached it. Reading such
 * a body as "accepted, its answer unreadable" is what silently lost a sent message under a portal
 * (cross-client rig, `1.4.1-alpha.3`): the outbox dropped an entry the server never received.
 *
 * So the question "who answered?" is decided HERE, at the throw, from facts the response already
 * carries, and travels as a type: {@link NotFromApiError} is a {@link TransportFailureError}, so
 * the one predicate (`isTransportFailure`) and every caller that already keeps and retries on a
 * transport failure read it with no new branch.
 *
 * - The CONTENT TYPE decides first ({@link responseOrigin}, the helper the refusal paths already
 *   use to tell the edge from the gateway): a 2xx without a JSON type was not written by the API,
 *   and its body is never read.
 * - A JSON type whose body does not PARSE is not the API's answer either (an empty body, a
 *   truncated one): the same type, carrying the parse error as its cause.
 * - A body that parses is the API's answer, WHATEVER ITS SHAPE: a field it lacks (a server older
 *   than the field) is the caller's question, never this helper's.
 */

import { TransportFailureError } from './transportFailure';

/**
 * WHO ANSWERED: our gateway (`gateway`, a JSON body) or something in front of it (`edge`: the host's
 * CrowdSec WAF 'Ban' page, a CDN or proxy error page - HTML or any non-JSON body).
 *
 * Read from the `Content-Type` HEADER, never from the body's words. The same status means opposite
 * things by origin: a gateway 403 is a verdict on the caller, an edge 403 is a verdict on the
 * network path and says nothing about the caller. Classify it at the THROW with this one helper.
 */
export type ResponseOrigin = 'gateway' | 'edge';

/** See {@link ResponseOrigin}. A response with no JSON content type was not written by the gateway. */
export function responseOrigin(res: Pick<Response, 'headers'>): ResponseOrigin {
  const type = res.headers.get('content-type') ?? '';
  return /json/i.test(type) ? 'gateway' : 'edge';
}

/**
 * A 2xx answered by something IN FRONT of the API - its body is not the API's JSON. No answer from
 * the API, so nothing it would have decided may be assumed: the caller keeps what it was sending
 * and retries exactly as for any other transport failure.
 */
export class NotFromApiError extends TransportFailureError {
  constructor(
    /** What was being asked, for the log (`POST /api/mls/send`). */
    readonly where: string,
    /** The status the impostor answered with - a 2xx, which is the whole point. */
    readonly status: number,
    /** The `Content-Type` it sent, or null when it sent none. */
    readonly contentType: string | null,
    /** The parse error, when the type claimed JSON and the body was not; null otherwise. */
    cause: unknown = null
  ) {
    super(
      cause,
      `${where} answered ${status} with ${contentType ?? 'no content type'}` +
        `${cause === null ? '' : ` and an unparseable body (${String(cause)})`}` +
        ' - not the API, read as no answer'
    );
    this.name = 'NotFromApiError';
  }
}

/**
 * Throws {@link NotFromApiError} unless `res` carries the API's JSON content type. For a 2xx whose
 * BODY the caller does not need: the header alone proves who answered. The unread body is released.
 *
 * @param where What was asked, for the log line the caller writes from the error.
 */
export function assertAnsweredByApi(res: Response, where: string): void {
  if (responseOrigin(res) === 'gateway') return;
  res.body?.cancel().catch((e: unknown) => {
    console.debug(`[HTTP] ${where}: the non-API body could not be released:`, e);
  });
  throw new NotFromApiError(where, res.status, res.headers.get('content-type'));
}

/**
 * The parsed JSON body of a 2xx from the API, or {@link NotFromApiError} when the response is not
 * the API's (see the module comment for the three cases). A body read that fails rejects with the
 * engine's own error, untouched - that is a lost link, not an impostor.
 *
 * @param where What was asked, for the log line the caller writes from the error.
 */
export async function readApiJson(res: Response, where: string): Promise<unknown> {
  assertAnsweredByApi(res, where);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new NotFromApiError(where, res.status, res.headers.get('content-type'), e);
  }
}
