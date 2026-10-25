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

import { isContractRefusalCode } from './refusalCodes';
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
 * WHO REFUSED, for a refusal whose reading DESTROYS something (a sign-out, a retired conversation, a
 * forgotten exit): `gateway` only when the JSON body is one of the three shapes our services write.
 *
 * - NEST'S ENVELOPE, whose `statusCode` repeats the HTTP status (`{ statusCode, message, error }`):
 *   no service here installs an exception filter, so every `HttpException` built from a string and
 *   every guard refusal leaves in that shape.
 * - A CODED REFUSAL, `{ code, message, ...extra }` (`refusalBody`): an `HttpException` built from an
 *   OBJECT is serialised as that object alone, WITHOUT `statusCode`. Believed only when `code` is
 *   one of the shared contract's ({@link isContractRefusalCode}) - the membership refusals
 *   (`NOT_A_MEMBER`, `MEMBERSHIP_NOT_ALLOWED`) a removed member is answered with take this shape,
 *   and reading them as the edge's kept a removed member's conversation and replayed an owed leave
 *   forever. An unknown `code` string proves nothing.
 * - THE 409 OF A SEAT AWAITING ADMISSION, `{ error: 'awaiting_admission', message }`
 *   ({@link isAwaitingAdmissionBody}): the delivery service's answer to a pending member, which no
 *   reader destroys anything on - recognised so a log or an error names its origin truthfully.
 *
 * WHY THE HEADER ALONE IS NOT ENOUGH HERE: the estate sits behind an edge that can answer in JSON
 * too (a WAF or CDN block page served as `application/json`, `{ type, title, status, detail,
 * error_code }`). Its body never repeats the status as `statusCode` and never carries a contract
 * code, so these shapes separate it where {@link responseOrigin} cannot. The gateway's own error
 * pages (nginx) imitate the envelope for 413/429/5xx, and for a 404 under `/api/media/public/live/`:
 * no destructive reader acts on those statuses, nor on that route. A body that does not parse is the
 * edge's. The body is read from a CLONE, so the caller can still
 * read or report the original.
 *
 * Non-destructive readings keep {@link responseOrigin}: a misread there costs a retry, not a state.
 */
export async function refusalOrigin(res: Response): Promise<ResponseOrigin> {
  if (responseOrigin(res) === 'edge') return 'edge';
  let body: unknown;
  try {
    body = JSON.parse(await res.clone().text());
  } catch (e) {
    console.debug(`[HTTP] a ${res.status} with a JSON type did not parse - read as the edge's:`, e);
    return 'edge';
  }
  if (!body || typeof body !== 'object') {
    console.debug(`[HTTP] a ${res.status} whose JSON is not an object - read as the edge's`);
    return 'edge';
  }
  const { statusCode, code } = body as { statusCode?: unknown; code?: unknown };
  if (statusCode === res.status || isContractRefusalCode(code)) return 'gateway';
  if (isAwaitingAdmissionBody(res.status, body)) return 'gateway';
  console.debug(
    `[HTTP] a ${res.status} JSON body is neither Nest's envelope, a contract refusal code nor an awaiting-admission answer` +
      ` (code ${typeof code === 'string' ? code : 'absent'}) - read as the edge's`
  );
  return 'edge';
}

/**
 * The `code` field of a refusal's JSON body, or `null` when the body is not JSON, not an object, or
 * carries no string code. Read from a CLONE, like {@link refusalOrigin}, so the caller can still read
 * the original. Call it only on a refusal {@link refusalOrigin} attributed to the gateway: a code is a
 * typed answer of our own services, never a word an edge chose.
 */
export async function refusalBodyCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(await res.clone().text());
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : null;
  } catch (e) {
    console.debug(`[HTTP] a ${res.status} refusal body did not parse - it carries no code:`, e);
    return null;
  }
}

/** The `error` the delivery service names a seat still awaiting a member's admission with. */
export const AWAITING_ADMISSION_ERROR = 'awaiting_admission';

/**
 * Whether a parsed refusal body is the delivery service's 409 for a seat still awaiting a member's
 * admission (`awaitingAdmissionRefusal`, `{ error: 'awaiting_admission', message }`). Status AND
 * field, the one reading `awaitingAdmissionFrom` (`mlsDeliveryApi.ts`) and {@link refusalOrigin} share.
 *
 * @param status The HTTP status of the refusal.
 * @param body Its parsed JSON body.
 */
export function isAwaitingAdmissionBody(status: number, body: unknown): boolean {
  return (
    status === 409 &&
    !!body &&
    typeof body === 'object' &&
    (body as { error?: unknown }).error === AWAITING_ADMISSION_ERROR
  );
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
