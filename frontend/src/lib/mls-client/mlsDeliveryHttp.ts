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

/** Throws a descriptive error if the HTTP response status is not 2xx, including up to 300 chars of body. */
export async function assertOkMlsDeliveryResponse(
  response: Response,
  context: string
): Promise<void> {
  if (response.ok) return;
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

/**
 * Fire-and-forget POST to chat-delivery; `keepalive` survives tab unload.
 *
 * Resolves with the parsed JSON body when the server sent one, and `null` otherwise - a transport
 * failure, a non-2xx, or a body that is not JSON. Callers that only push are free to ignore it, but
 * several of these endpoints ANSWER (`history-request` says `no_peer_online` when it could reach
 * nobody), and discarding that answer made the client wait out a 30 s window for a question the
 * server had already settled. `null` therefore means "no answer", never "no".
 */
export async function deliveryKeepalivePost(
  historyUrl: string,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${historyUrl}/api/mls/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch((e) => {
    console.warn(`[HTTP] ${path} failed:`, e);
    return null;
  });
  if (!res || !res.ok) return null;
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
