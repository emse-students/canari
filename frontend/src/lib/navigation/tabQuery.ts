/**
 * A FIXED SEGMENTED CONTROL THAT SURVIVES A RELOAD: the open segment lives in `?tab=`.
 *
 * Two admin pages (moderation 3, legacy dues 4) and the shop (products, partnerships) keep a
 * handful of short segments that fit a phone without scrolling. They stay segmented controls - the
 * user's rule is that a set of three or four short labels is not worth a level of depth - but the
 * choice used to be local `$state`, lost on reload and unlinkable. The query is read ONCE at load
 * and written with SvelteKit's `replaceState`, so a tab switch adds no history entry and Back still
 * leaves the page.
 */
import { appPathFromPathname } from '$lib/utils/internalPath';

/** Narrows an untrusted query value to one of `allowed`, else `fallback`. */
export function parseTab<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

/**
 * The base-less app path with `?tab=` set to `tab`, or removed when `tab` is the default so the
 * bare path stays the canonical link. The caller passes it through `resolve(internalPath(...))`. Every other query parameter and the hash are kept.
 */
export function tabUrl(current: Pick<URL, 'href'>, tab: string, fallback: string): string {
  const next = new URL(current.href);
  if (tab === fallback) next.searchParams.delete('tab');
  else next.searchParams.set('tab', tab);
  return `${appPathFromPathname(next.pathname)}${next.search}${next.hash}`;
}

/**
 * The base-less app path with the query parameters `names` removed, every other one (`?tab=`
 * included) and the hash kept. For a one-shot marker a page consumes on arrival - the shop's
 * `purchase_success` - so a reload does not consume it twice.
 */
export function withoutQuery(current: Pick<URL, 'href'>, names: readonly string[]): string {
  const next = new URL(current.href);
  for (const name of names) next.searchParams.delete(name);
  return `${appPathFromPathname(next.pathname)}${next.search}${next.hash}`;
}
