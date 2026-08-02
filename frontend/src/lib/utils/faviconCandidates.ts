/**
 * Conventional icon paths, tried in order once the site's declared icon is out.
 *
 * `.ico` first because it is the one path every server has answered for twenty
 * years, then the modern formats. An `<img>` renders whichever of them exists -
 * the extension decides nothing, the bytes do.
 */
const CONVENTIONAL_ICON_PATHS = [
  '/favicon.ico',
  '/favicon.svg',
  '/favicon.png',
  '/apple-touch-icon.png',
];

/**
 * Builds the ordered list of favicon URLs to try for `pageUrl`, best first.
 *
 * The declared icon comes first: it is what the site itself points at, in
 * whatever format it chose. The conventional paths follow, because a declaration
 * can be absent (the preview fetch failed) or stale (it 404s), and a single
 * missing `/favicon.ico` must not be the end of the search - a site whose SPA
 * answers `index.html` on that path still has a real icon one entry down.
 *
 * Only http(s) URLs are kept: these end up in an `<img src>`, and the payload
 * carrying the declared icon is built from someone else's markup.
 *
 * @param pageUrl - the previewed page URL, whose origin the conventions hang off
 * @param declaredIcon - the icon the server read from the page's `<link rel="icon">`
 * @returns absolute URLs, deduplicated, in the order they should be attempted
 */
export function faviconCandidates(pageUrl: string, declaredIcon?: string | null): string[] {
  const candidates: string[] = [];

  const add = (value: string | null | undefined) => {
    if (!value || !/^https?:\/\//i.test(value)) return;
    if (!candidates.includes(value)) candidates.push(value);
  };

  add(declaredIcon);

  try {
    const origin = new URL(pageUrl).origin;
    for (const path of CONVENTIONAL_ICON_PATHS) {
      add(new URL(path, origin).toString());
    }
  } catch {
    // No parseable origin means no conventions to derive: the declared icon,
    // if there was one, is the whole list.
  }

  return candidates;
}
