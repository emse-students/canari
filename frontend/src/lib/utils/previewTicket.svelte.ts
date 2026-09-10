import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';

/**
 * THE CLIENT HALF OF THE LINK-PREVIEW IMAGE TICKET.
 *
 * `mls/link-preview/image` is put into an `<img src>`, so the browser makes that request itself and
 * can carry no `Authorization` header. The server therefore accepts a short-lived ticket in the
 * query string instead of a session, and this module is what holds one: an authenticated call mints
 * it, every proxied image URL carries it, and it is refreshed before it lapses.
 *
 * It is `$state` rather than a plain variable because the URLs are `$derived`: a component that
 * rendered before the first ticket arrived has to re-derive when it does, and nothing else would
 * tell it to. `proxiedPreviewImageUrl` returns an empty string until then, which every caller
 * already treats as "no image", so the alternative - a URL that is certain to 401 - is never put in
 * front of a browser.
 */

/** The current ticket, or `''` before the first one lands. Reactive on purpose - see above. */
let ticket = $state('');

/** When the current ticket stops being minted for, as an epoch ms. */
let expiresAt = 0;

/** The refresh in flight, so a hundred cards render one request rather than a hundred. */
let inflight: Promise<void> | null = null;

/** Refreshed this far before expiry, so a ticket is never spent on a request that outlives it. */
const REFRESH_MARGIN_MS = 30_000;

/** The ticket to put on a proxied image URL, or `''` when none has been obtained yet. */
export function previewTicket(): string {
  return ticket;
}

/**
 * Obtains a ticket if the held one is missing or about to lapse.
 *
 * Never throws and never retries on a schedule: a failure leaves `ticket` as it was, the derived
 * URLs stay empty, and the next render asks again. A preview image that does not appear is a
 * cosmetic loss, and a background loop retrying a 401 for a signed-out reader would not be.
 */
export async function ensurePreviewTicket(): Promise<void> {
  if (ticket && Date.now() < expiresAt - REFRESH_MARGIN_MS) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await apiFetch(`${deliveryUrl()}/api/mls/link-preview/ticket`);
      if (!res.ok) return;
      const data = (await res.json()) as { ticket?: string; expiresInMs?: number };
      if (typeof data.ticket !== 'string' || data.ticket.length === 0) return;
      ticket = data.ticket;
      expiresAt = Date.now() + (data.expiresInMs ?? 0);
    } catch {
      // Offline, or no session - both leave the previous ticket in place and cost only an image.
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
