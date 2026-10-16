import { Log } from '$lib/utils/Log';
import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';

/**
 * THE GIF SEARCH, ASKED OF CANARI AND NEVER OF THE PROVIDER (owner decision 2026-10-16).
 *
 * The picker used to call KLIPY's API from the browser, which handed KLIPY the search terms, the
 * reader's IP and a persistent per-install `customer_id`, and shipped the API key inside every
 * bundle. Now it calls chat-delivery's `GET /api/mls/gifs`, which asks KLIPY with the server's key
 * and one shared customer id, and answers only an id, two URLs and their sizes per result
 * (`apps/chat-delivery-service/src/utils/klipy.ts`). The client no longer knows KLIPY's format.
 *
 * WHAT A RESULT CARRIES: a URL to show in the grid, a URL to send, and the SIZE of each - what lets
 * the grid reserve every tile before it loads (`gifMasonry.ts`) and what the MediaFrame contract
 * asks a picker to send with its URL (`docs/wiki/frontend/media-frame.md`, section 3). The server
 * leaves out a result without one.
 */

/** One rendition of a GIF: where it is and how big it is. */
export interface GifRendition {
  url: string;
  width: number;
  height: number;
}

export interface GifResult {
  id: string;
  /** The small rendition, for the grid. */
  preview: GifRendition;
  /** The medium rendition, which is what is sent. */
  full: GifRendition;
}

export interface GifPage {
  gifs: GifResult[];
  /** Whether asking for the next page can return more. */
  hasNext: boolean;
}

/**
 * The `code` chat-delivery puts on its 503 when the estate has no KLIPY key
 * (`GIF_SEARCH_NOT_CONFIGURED` in `gif-search.controller.ts`). A 503 ALONE does not say it: nginx
 * and the edge answer 503 of their own when an upstream is down, and that is a load failure.
 */
export const GIF_SEARCH_NOT_CONFIGURED = 'gif_search_not_configured';

/** Whether a 503 is chat-delivery saying the estate has no key, read from its body's `code`. */
async function isNotConfiguredAnswer(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { code?: unknown } | null;
    return body?.code === GIF_SEARCH_NOT_CONFIGURED;
  } catch {
    // Not JSON: not chat-delivery's answer, so an upstream failure - the caller says "could not load".
    return false;
  }
}

/**
 * The estate has no GIF provider key (chat-delivery's 503 with `GIF_SEARCH_NOT_CONFIGURED`). A
 * TYPE, so the grid shows "not configured" rather than "could not load" without reading a message.
 */
export class GifSearchUnavailableError extends Error {
  constructor() {
    super('GIF search is not configured on this estate');
    this.name = 'GifSearchUnavailableError';
  }
}

function isRendition(value: unknown): value is GifRendition {
  const r = value as GifRendition | null;
  return (
    !!r && typeof r.url === 'string' && /^https:\/\//i.test(r.url) && r.width > 0 && r.height > 0
  );
}

/**
 * Keeps the results whose shape the grid can use. The server already filters; this is the client's
 * own check on what reaches an `<img src>`, and a count at warn level if it ever drops anything.
 */
export function readGifPage(body: unknown): GifPage {
  const raw = (body ?? {}) as { gifs?: unknown; hasNext?: unknown };
  const items = Array.isArray(raw.gifs) ? raw.gifs : [];
  const gifs = items.filter(
    (g): g is GifResult =>
      !!g &&
      typeof (g as GifResult).id === 'string' &&
      isRendition((g as GifResult).preview) &&
      isRendition((g as GifResult).full)
  );
  if (gifs.length < items.length) {
    console.warn(`[GifSearch] ${items.length - gifs.length} of ${items.length} results malformed`);
  }
  return { gifs, hasNext: raw.hasNext === true };
}

/**
 * Fetches one page of trending GIFs (empty `query`) or of a search, through Canari. Throws
 * `GifSearchUnavailableError` when the estate has no provider key, and an `Error` on a transport
 * failure or any other non-2xx answer; the caller shows the matching state.
 */
export async function fetchGifPage(
  query: string,
  page: number,
  signal?: AbortSignal
): Promise<GifPage> {
  const trimmed = query.trim();
  const params = new URLSearchParams({ page: String(page) });
  if (trimmed) params.set('q', trimmed);
  const res = await apiFetch(`${deliveryUrl()}/api/mls/gifs?${params.toString()}`, { signal });
  if (res.status === 503 && (await isNotConfiguredAnswer(res))) {
    throw new GifSearchUnavailableError();
  }
  if (!res.ok) throw new Error(`GIF search HTTP ${res.status}`);
  const result = readGifPage(await res.json());
  Log.d(
    'GifSearch',
    `${trimmed ? 'search' : 'trending'} p${page}: ${result.gifs.length} (next: ${result.hasNext})`
  );
  return result;
}
