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
  /**
   * The smallest rendition, when the server sent one smaller than `preview`. The grid draws the
   * lightest rendition that still covers its tile (`pickGridRendition`).
   */
  tiny?: GifRendition;
  /** The small rendition: the grid's, and the one a comment attaches (`commentGifRendition`). */
  preview: GifRendition;
  /** The medium rendition, which is what is sent in a chat. */
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
  const gifs = items
    .filter(
      (g): g is GifResult =>
        !!g &&
        typeof (g as GifResult).id === 'string' &&
        isRendition((g as GifResult).preview) &&
        isRendition((g as GifResult).full)
    )
    // A malformed `tiny` costs only itself: the result stays usable on its `preview`.
    .map((g) => (g.tiny !== undefined && !isRendition(g.tiny) ? { ...g, tiny: undefined } : g));
  if (gifs.length < items.length) {
    console.warn(`[GifSearch] ${items.length - gifs.length} of ${items.length} results malformed`);
  }
  return { gifs, hasNext: raw.hasNext === true };
}

/** How long a page of results may take before it counts as failed. */
export const GIF_SEARCH_TIMEOUT_MS = 10_000;

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
  // A search that never answers is a failure the reader can retry, not a spinner for good.
  const deadline = AbortSignal.timeout(GIF_SEARCH_TIMEOUT_MS);
  const res = await apiFetch(`${deliveryUrl()}/api/mls/gifs?${params.toString()}`, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
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

/**
 * The lightest rendition that still COVERS a tile `tileWidth` CSS px wide: the narrowest of the
 * candidates that is at least as wide as the tile, else the widest there is. Chosen from the sizes
 * the provider declared, never from a guess about them - a GIF whose tiny rendition is too narrow
 * for the tile is drawn from its preview, and a phone's 180 px tile is not made to download a 2.9 MB
 * thumbnail when a 200 px one exists. A tile not yet measured (0) asks for nothing wider than the
 * lightest rendition.
 */
export function pickGridRendition(gif: GifResult, tileWidth: number): GifRendition {
  const candidates = [gif.tiny, gif.preview].filter((r): r is GifRendition => !!r);
  const covering = candidates.filter((r) => r.width >= tileWidth);
  const pool =
    covering.length > 0 ? covering : [candidates.reduce((a, b) => (b.width > a.width ? b : a))];
  return pool.reduce((a, b) => (b.width < a.width ? b : a));
}

/** The widest a comment draws a GIF (`max-w-56`, 224 px): the smallest rendition this wide is plenty. */
export const COMMENT_GIF_WIDTH = 200;

/**
 * The rendition a GIF attached to a comment is downloaded in. A comment shows it at most
 * {@link COMMENT_GIF_WIDTH} px wide, so the small rendition is enough: the medium one the chat sends
 * (median 1.1 MB, up to 11.7 MB, against a relay ceiling of 12 MiB) was downloaded in full only to
 * be encrypted and uploaded again. The medium one remains for a GIF whose small rendition is too
 * narrow to be drawn at that width.
 */
export function commentGifRendition(gif: GifResult): GifRendition {
  return gif.preview.width >= COMMENT_GIF_WIDTH ? gif.preview : gif.full;
}
