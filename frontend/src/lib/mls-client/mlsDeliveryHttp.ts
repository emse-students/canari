/** Resolved public URLs for chat-gateway (WS) and chat-delivery (MLS HTTP). */
export type MlsPublicUrls = { baseUrl: string; historyUrl: string };

/**
 * Prefer `VITE_GATEWAY_URL` / `VITE_DELIVERY_URL`; fall back to same-origin in the browser
 * (reverse proxy routes `/api/ws` and `/api/mls/`). Empty env strings mean "not configured".
 */
export function resolveMlsPublicUrls(): MlsPublicUrls {
  const envGateway = import.meta.env.VITE_GATEWAY_URL;
  const baseUrl =
    envGateway && String(envGateway).trim()
      ? String(envGateway).trim()
      : typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost:3000';

  const envHistory = import.meta.env.VITE_DELIVERY_URL;
  const historyUrl =
    envHistory && String(envHistory).trim()
      ? String(envHistory).trim()
      : typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost:3010';

  return { baseUrl, historyUrl };
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
    `Impossible d'envoyer l'invitation sécurisée (${context}). ` +
      `Le serveur a répondu ${response.status} ${response.statusText}${details}`
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
