import { parsePostFeed, type PostFeed } from '$lib/posts/api';

/**
 * THE FEED ADDRESS THAT NAMES ITS OWN TAB (Mi 9T, `1.7.0-alpha.4`: a Back to the feed from an
 * association came back on "Pour toi" at the top after the reader left "Organisations" scrolled).
 *
 * A bare `/posts` carries no tab: `load` resolves it from the reader's REMEMBERED preference, which
 * any later tap on a tab overwrites. An entry of the history addressed bare therefore reopens on
 * whatever tab was chosen LAST, not on the one it showed when it was left, and its remembered
 * anchor then points into another list (the restore ends on the logged fallback, at the top). The
 * place a Back returns to has to be the entry's own: the tab is written into the address once the
 * page knows which list it drew, with a shallow `replaceState` (no navigation, no load, no new
 * entry, the same history key), so every `/posts` entry names its tab for the rest of the document.
 *
 * Returns the base-less app path to write, or null when the address already names a tab (a link
 * someone was sent, a tab tap) or the page is carrying a one-shot command that its own strip
 * rewrites first. The preference is NEVER touched here: only a click on a tab is a choice.
 */
export function feedNamedPath(current: Pick<URL, 'href'>, feed: PostFeed): string | null {
  const url = new URL(current.href);
  if (parsePostFeed(url.searchParams.get('feed')) !== null) return null;
  if (url.searchParams.get('compose') === '1' || url.searchParams.get('search') === '1')
    return null;
  url.searchParams.set('feed', feed);
  return `/posts?${url.searchParams.toString()}${url.hash}`;
}
