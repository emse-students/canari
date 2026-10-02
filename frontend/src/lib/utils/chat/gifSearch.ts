import { Log } from '$lib/utils/Log';

/**
 * KLIPY, THE GIF PROVIDER (Tenor stopped issuing keys; Giphy's free tier is 100 requests an hour).
 * The key is optional: with none the composer offers no GIF entry at all.
 *
 * WHAT A RESULT MUST CARRY: a URL to show in the grid, a URL to send, and the SIZE of each. The size
 * is what lets the grid reserve every tile before it loads (`gifMasonry.ts`), and what the MediaFrame
 * contract asks a picker to send with its URL (`docs/wiki/frontend/media-frame.md`, section 3). A
 * result without one cannot be laid out without a shift, so it is LEFT OUT and counted at warn level -
 * a provider that stopped declaring sizes is then a number in the log, not a grid that jumps.
 */

export const KLIPY_KEY = (import.meta.env as Record<string, string | undefined>).VITE_KLIPY_KEY;

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

/** Results per page: three screens of a two-column phone grid. */
export const GIF_PAGE_SIZE = 24;

type RawRendition = { gif?: { url?: unknown; width?: unknown; height?: unknown } };

function rendition(raw: RawRendition | undefined): GifRendition | null {
  const g = raw?.gif;
  if (!g || typeof g.url !== 'string' || !g.url) return null;
  const width = Number(g.width);
  const height = Number(g.height);
  if (!(width > 0) || !(height > 0)) return null;
  return { url: g.url, width, height };
}

/** Maps KLIPY's items to results, leaving out (and counting) any without a sized rendition. */
export function mapKlipyItems(items: unknown[]): { gifs: GifResult[]; dropped: number } {
  const gifs: GifResult[] = [];
  let dropped = 0;
  for (const raw of items ?? []) {
    const item = raw as { id?: string | number; file?: Record<string, RawRendition> };
    const file = item.file ?? {};
    const preview = rendition(file.sm) ?? rendition(file.xs) ?? rendition(file.md);
    const full = rendition(file.md) ?? rendition(file.hd) ?? rendition(file.sm);
    const id = String(item.id ?? '');
    if (!id || !preview || !full) {
      dropped++;
      continue;
    }
    gifs.push({ id, preview, full });
  }
  return { gifs, dropped };
}

/** A stable anonymous id: KLIPY's API expects a `customer_id` per user for its own analytics. */
function customerId(): string {
  try {
    let id = localStorage.getItem('klipy_cid');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('klipy_cid', id);
    }
    return id;
  } catch (error) {
    console.warn(
      `[GifSearch] no storage for the KLIPY customer id, sent anonymous: ${String(error)}`
    );
    return 'anonymous';
  }
}

/**
 * Fetches one page of trending GIFs (empty `query`) or of a search. Throws on a transport failure or
 * a non-2xx answer; the caller shows its error state.
 */
export async function fetchGifPage(
  query: string,
  page: number,
  signal?: AbortSignal
): Promise<GifPage> {
  if (!KLIPY_KEY) return { gifs: [], hasNext: false };
  const trimmed = query.trim();
  const cid = encodeURIComponent(customerId());
  const base = `https://api.klipy.com/api/v1/${KLIPY_KEY}`;
  const paging = `per_page=${GIF_PAGE_SIZE}&page=${page}&customer_id=${cid}`;
  const url = trimmed
    ? `${base}/gifs/search?q=${encodeURIComponent(trimmed)}&${paging}`
    : `${base}/gifs/trending?${paging}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`KLIPY HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { data?: unknown[]; has_next?: unknown } };
  const items = json?.data?.data ?? [];
  const { gifs, dropped } = mapKlipyItems(items);
  if (dropped > 0) {
    console.warn(
      `[GifSearch] ${dropped} of ${items.length} results declared no size and were left out`
    );
  }
  // `has_next` when KLIPY sends it; a short page is the end either way.
  const hasNext =
    typeof json?.data?.has_next === 'boolean' ? json.data.has_next : items.length >= GIF_PAGE_SIZE;
  Log.d(
    'GifSearch',
    `${trimmed ? 'search' : 'trending'} p${page}: ${gifs.length} (next: ${hasNext})`
  );
  return { gifs, hasNext };
}
