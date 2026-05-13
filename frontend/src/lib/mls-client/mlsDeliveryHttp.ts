/** Resolved public URLs for chat-gateway (WS) and chat-delivery (MLS HTTP). */
export type MlsPublicUrls = { baseUrl: string; historyUrl: string };

/**
 * Prefer `VITE_GATEWAY_URL` / `VITE_DELIVERY_URL`; fall back to same-origin in the browser
 * (reverse proxy routes `/api/ws` and `/api/mls/`). Empty env strings mean “not configured”.
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

/** Fire-and-forget POST to chat-delivery; `keepalive` survives tab unload. */
export async function deliveryKeepalivePost(
  historyUrl: string,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<void> {
  await fetch(`${historyUrl}/api/mls/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch((e) => console.warn(`[HTTP] ${path} failed:`, e));
}
