import { OUTBOUND_BUDGET_MS } from './url-guard';

/**
 * KLIPY, THE GIF PROVIDER, ASKED BY THE SERVER AND NEVER BY THE BROWSER (owner decision 2026-10-16).
 *
 * The picker used to call `api.klipy.com` from the reader's browser, which handed KLIPY the search
 * terms, the reader's IP and a persistent per-install `customer_id`, and shipped the API key inside
 * every bundle. Asked from here, KLIPY sees chat-delivery's address, the query and ONE constant
 * customer id shared by every reader - nothing that tells two readers apart.
 *
 * WHAT A RESULT MUST CARRY: a URL to show in the grid, a URL to send, and the SIZE of each. The size
 * is what lets the grid reserve every tile before it loads (`frontend/.../gifMasonry.ts`), and what
 * the MediaFrame contract asks a picker to send with its URL (`docs/wiki/frontend/media-frame.md`,
 * section 3). A result without one cannot be laid out without a shift, so it is LEFT OUT and counted
 * - a provider that stopped declaring sizes is then a number in the log, not a grid that jumps.
 * [chat](../../../../docs/wiki/frontend/modules/chat.md)
 */

/** Results per page: three screens of a two-column phone grid. */
export const GIF_PAGE_SIZE = 24;

/** The longest search the route accepts; a GIF search is a word or two. */
export const GIF_QUERY_MAX_LENGTH = 100;

/** The deepest page the route accepts - far past what anybody scrolls, short of a crawl. */
export const GIF_MAX_PAGE = 50;

/**
 * The `customer_id` KLIPY's API asks for. It is meant to identify a user for KLIPY's analytics,
 * which is exactly what this proxy exists to withhold, so every request carries the same constant.
 */
export const KLIPY_SHARED_CUSTOMER_ID = 'canari-server';

/** One rendition of a GIF: where it is and how big it is. */
export interface GifRendition {
  url: string;
  width: number;
  height: number;
}

export interface GifResult {
  id: string;
  /**
   * The smallest rendition, present only when it is strictly smaller than `preview`. The grid draws
   * the lightest rendition that still covers its tile (`pickGridRendition` in the client), so a
   * phone showing 180 px tiles is not made to download a 2.9 MB thumbnail when a smaller one is as
   * wide as it needs. Optional because KLIPY does not send it for every GIF, and for a client that
   * does not know it: it simply keeps using `preview`.
   */
  tiny?: GifRendition;
  /** The small rendition, for the grid (and for a GIF attached to a comment). */
  preview: GifRendition;
  /** The medium rendition, which is what is sent. */
  full: GifRendition;
}

export interface GifPage {
  gifs: GifResult[];
  /** Whether asking for the next page can return more. */
  hasNext: boolean;
}

/** A non-2xx answer from KLIPY, typed so the controller maps it without reading prose. */
export class KlipyHttpError extends Error {
  constructor(readonly status: number) {
    super(`KLIPY answered HTTP ${status}`);
    this.name = 'KlipyHttpError';
  }
}

/** KLIPY said NOTHING: a DNS or connect failure, a reset, or the outbound budget running out. */
export class KlipyUnreachableError extends Error {
  constructor(cause: unknown) {
    super(String(cause));
    this.name = 'KlipyUnreachableError';
  }
}

/** KLIPY answered 2xx with a body that is not the JSON it documents - an answer, but unusable. */
export class KlipyMalformedAnswerError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'KlipyMalformedAnswerError';
  }
}

type RawRendition = { gif?: { url?: unknown; width?: unknown; height?: unknown } };

function rendition(raw: RawRendition | undefined): GifRendition | null {
  const g = raw?.gif;
  if (!g || typeof g.url !== 'string' || !/^https:\/\//i.test(g.url)) return null;
  const width = Number(g.width);
  const height = Number(g.height);
  if (!(width > 0) || !(height > 0)) return null;
  return { url: g.url, width, height };
}

/**
 * Maps KLIPY's items to results, leaving out (and counting) any without a sized https rendition.
 * Only the id, the renditions' URLs and their sizes leave this function: nothing else KLIPY sends reaches
 * a client.
 */
export function mapKlipyItems(items: unknown[]): { gifs: GifResult[]; dropped: number } {
  const gifs: GifResult[] = [];
  let dropped = 0;
  for (const raw of items ?? []) {
    const item = (raw ?? {}) as { id?: string | number; file?: Record<string, RawRendition> };
    const file = item.file ?? {};
    const preview = rendition(file.sm) ?? rendition(file.xs) ?? rendition(file.md);
    const full = rendition(file.md) ?? rendition(file.hd) ?? rendition(file.sm);
    const id = String(item.id ?? '');
    if (!id || !preview || !full) {
      dropped++;
      continue;
    }
    const tiny = rendition(file.xs);
    gifs.push({
      id,
      ...(tiny && tiny.width < preview.width ? { tiny } : {}),
      preview,
      full,
    });
  }
  return { gifs, dropped };
}

/**
 * The KLIPY URL for one page of trending GIFs (empty `query`) or of a search. The query and the
 * page are the only caller-derived parts; the key is the server's.
 */
export function klipyPageUrl(apiKey: string, query: string, page: number): string {
  const base = `https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}`;
  const paging =
    `per_page=${GIF_PAGE_SIZE}&page=${page}` +
    `&customer_id=${encodeURIComponent(KLIPY_SHARED_CUSTOMER_ID)}`;
  return query
    ? `${base}/gifs/search?q=${encodeURIComponent(query)}&${paging}`
    : `${base}/gifs/trending?${paging}`;
}

/**
 * Fetches and maps one page from KLIPY. The request carries no header naming the reader - no
 * `X-Forwarded-For`, no user agent of theirs - so the only address KLIPY can log is this server's.
 * Bounded by the repository's one outbound budget. Throws `KlipyHttpError` on a non-2xx answer,
 * `KlipyUnreachableError` when KLIPY said nothing, and `KlipyMalformedAnswerError` on a body that is
 * not JSON.
 */
export async function fetchKlipyPage(
  apiKey: string,
  query: string,
  page: number
): Promise<{ page: GifPage; received: number; dropped: number }> {
  // Each failure is typed where it happens, so the caller never reads a message to tell "KLIPY
  // never answered" from "KLIPY answered something unusable".
  let res: Response;
  try {
    res = await fetch(klipyPageUrl(apiKey, query, page), {
      signal: AbortSignal.timeout(OUTBOUND_BUDGET_MS),
      headers: { accept: 'application/json', 'user-agent': 'CanariGifSearch/1.0' },
    });
  } catch (error) {
    throw new KlipyUnreachableError(error);
  }
  if (!res.ok) throw new KlipyHttpError(res.status);
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    // The body died mid-read (a reset, or the budget expiring): no answer was received.
    throw new KlipyUnreachableError(error);
  }
  let json: { data?: { data?: unknown[]; has_next?: unknown } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new KlipyMalformedAnswerError(`a body that is not JSON (${text.length} bytes)`);
  }
  const items = Array.isArray(json?.data?.data) ? json.data.data : [];
  const { gifs, dropped } = mapKlipyItems(items);
  // `has_next` when KLIPY sends it; a short page is the end either way.
  const hasNext =
    typeof json?.data?.has_next === 'boolean' ? json.data.has_next : items.length >= GIF_PAGE_SIZE;
  return { page: { gifs, hasNext }, received: items.length, dropped };
}
