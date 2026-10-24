import type { GifPage } from './gifSearch';

/**
 * THE PAGES OF GIFS ALREADY READ THIS SESSION, so opening the picker again shows them AT ONCE.
 *
 * The grid wiped what it held every time it closed and asked the server for trending again, so each
 * opening began with an empty panel and a spinner - the slowest moment of the picker, repeated. The
 * server already says a page is good for five minutes (`Cache-Control: private, max-age=300`); this
 * keeps the same promise in memory, where it can be read before a frame is drawn. Per session and
 * per tab, never persisted: nothing here outlives the app being closed.
 */

/** How long a page is served from memory: the server's own `max-age`. */
export const GIF_PAGE_TTL_MS = 5 * 60_000;

/** Pages kept, trending's and the searches', oldest dropped first - a few screens of GIFs. */
const MAX_PAGES = 40;

const pages = new Map<string, { page: GifPage; at: number }>();

function keyOf(query: string, page: number): string {
  return `${query.trim().toLowerCase()}\u0000${page}`;
}

/** The page of `query` read less than {@link GIF_PAGE_TTL_MS} ago, or `null`. */
export function cachedGifPage(query: string, page: number, now = Date.now()): GifPage | null {
  const hit = pages.get(keyOf(query, page));
  if (!hit) return null;
  if (now - hit.at > GIF_PAGE_TTL_MS) {
    pages.delete(keyOf(query, page));
    return null;
  }
  return hit.page;
}

/** Remembers a page just read. */
export function rememberGifPage(
  query: string,
  page: number,
  value: GifPage,
  now = Date.now()
): void {
  const key = keyOf(query, page);
  pages.delete(key);
  pages.set(key, { page: value, at: now });
  while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value as string);
}

/** Forgets everything - for tests, and for a sign-out. */
export function clearGifPageCache(): void {
  pages.clear();
}
