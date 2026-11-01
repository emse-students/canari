import { assertAnsweredByApi, isAwaitingAdmissionBody } from '$lib/utils/apiJson';
import { deliveryUrl, gatewayUrl } from '$lib/utils/apiUrl';

/** Resolved public URLs for chat-gateway (WS) and chat-delivery (MLS HTTP). */
export type MlsPublicUrls = { baseUrl: string; historyUrl: string };

/**
 * Resolves the gateway and delivery origins through the ONE resolver in `apiUrl.ts`.
 *
 * This used to read `VITE_GATEWAY_URL` / `VITE_DELIVERY_URL` first and treat same-origin as their
 * fallback - the polarity that broke every call once the estate answered on two public hostnames.
 * It survived the first fix because that fix enumerated `apiUrl.ts` and its two known duplicates
 * and not the callers that had rebuilt the same logic elsewhere: `/api/mls/security/pin-salt` is
 * fetched from here, so unlocking a session still addressed the legacy origin and died on CSP
 * while login itself had started working.
 */
export function resolveMlsPublicUrls(): MlsPublicUrls {
  return { baseUrl: gatewayUrl(), historyUrl: deliveryUrl() };
}

/**
 * Throws a descriptive error if the HTTP response status is not 2xx, including up to 300 chars of
 * body - and `NotFromApiError` (a transport failure, no answer) for a 2xx that is not the
 * delivery service's JSON: a portal's `200` delivered no Welcome.
 */
export async function assertOkMlsDeliveryResponse(
  response: Response,
  context: string
): Promise<void> {
  if (response.ok) {
    assertAnsweredByApi(response, context);
    return;
  }
  let bodyPreview = '';
  try {
    bodyPreview = (await response.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  const details = bodyPreview ? ` - ${bodyPreview}` : '';
  throw new Error(
    `Could not send the secure invitation (${context}). ` +
      `The server answered ${response.status} ${response.statusText}${details}`
  );
}

/** Why chat-delivery refused a relay POST on membership: the two answers a caller may act on. */
export type DeliveryRefusalReason = 'not_a_member' | 'awaiting_admission';

/**
 * A relay POST the delivery service REFUSED on membership - an ANSWER, never "no answer": a 403
 * `NOT_A_MEMBER` (no seat in the group) or a 409 `awaiting_admission` (a seat no member admitted
 * yet). Typed from the status AND the body's code, never from its message, so a caller reads
 * `instanceof` and can mistake it neither for a body the server answered with nor for silence.
 */
export class DeliveryRefusal {
  constructor(
    readonly reason: DeliveryRefusalReason,
    /** The HTTP status it came with, for the caller's log. */
    readonly httpStatus: number
  ) {}
}

/**
 * The membership refusal `status` and `body` say, or `null` for any other non-2xx. The code is the
 * shared contract's (`refusalBody` on the server); the 409 is {@link isAwaitingAdmissionBody}'s
 * reading, the one every other reader of it shares.
 */
function membershipRefusalOf(status: number, body: unknown): DeliveryRefusalReason | null {
  if (status === 403 && (body as { code?: unknown } | null)?.code === 'NOT_A_MEMBER') {
    return 'not_a_member';
  }
  return isAwaitingAdmissionBody(status, body) ? 'awaiting_admission' : null;
}

/**
 * Fire-and-forget POST to chat-delivery; `keepalive` survives tab unload.
 *
 * Resolves with the parsed JSON body when the server sent one; with a {@link DeliveryRefusal} when
 * it refused the caller on membership (the relay routes - `history-request`, `base-refresh-request`,
 * `welcome-request` - ask the group, not only the login); and `null` otherwise - a transport
 * failure, any other non-2xx, or a body that is not JSON. Callers that only push are free to ignore
 * it, but several of these endpoints ANSWER (`history-request` says `no_peer_online` when it could
 * reach nobody), and discarding that answer made the client wait out a 30 s window for a question
 * the server had already settled. `null` therefore means "no answer", never "no".
 *
 * EVERY NON-2xx IS LOGGED WITH ITS STATUS AND CODE: it used to be dropped without a line, so a
 * refusal and a lost packet read the same in every console.
 */
export async function deliveryKeepalivePost(
  historyUrl: string,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<Record<string, unknown> | DeliveryRefusal | null> {
  const res = await fetch(`${historyUrl}/api/mls/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch((e) => {
    console.warn(`[HTTP] ${path} failed:`, e);
    return null;
  });
  if (!res) return null;
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Not JSON, or no body: read as no body - the branches below say what that means.
    parsed = null;
  }
  if (!res.ok) {
    const reason = membershipRefusalOf(res.status, parsed);
    const fields = parsed as { code?: unknown; error?: unknown } | null;
    const code = typeof fields?.code === 'string' ? fields.code : fields?.error;
    console.warn(
      `[HTTP] ${path} answered ${res.status} (${typeof code === 'string' ? code : 'no code'})` +
        (reason ? ` - refused: ${reason}` : ' - no answer')
    );
    return reason ? new DeliveryRefusal(reason, res.status) : null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}
