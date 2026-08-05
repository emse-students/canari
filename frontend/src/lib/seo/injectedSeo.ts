import { SEO_DATA_ELEMENT_ID } from '$lib/seo/renderHead';
import type { SeoMeta } from '$lib/seo/types';

/** What the server wrote into the shell for the page the browser was served. */
export interface InjectedSeo {
  path: string;
  meta: Partial<SeoMeta>;
}

/**
 * Reads the metadata `hooks.server.ts` injected for the FIRST page of this document.
 *
 * The server resolves a post's real title, an association's real description and their structured
 * data by calling the services; the client cannot, because those reads want an internal secret it
 * must never hold. So without this, hydration quietly downgrades the head of the very page the
 * server just enriched - and Googlebot, which renders before it indexes, would record the
 * downgrade.
 *
 * Read once and memoised, because `SeoHead` deletes the block (along with every other
 * `data-canari-seo` node) on mount: a second read would find nothing and could not tell that from
 * "the server never injected anything", which is the ordinary Tauri case.
 */
let memo: InjectedSeo | null | undefined;

export function readInjectedSeo(): InjectedSeo | null {
  if (memo !== undefined) return memo;
  memo = null;

  if (typeof document === 'undefined') return memo;
  const element = document.getElementById(SEO_DATA_ELEMENT_ID);
  const raw = element?.textContent?.trim();
  if (!raw) return memo;

  try {
    const parsed = JSON.parse(raw) as InjectedSeo;
    if (parsed && typeof parsed.path === 'string' && parsed.meta) memo = parsed;
  } catch {
    // A malformed payload is a bug in the injector, not a reason to break the page.
  }
  return memo;
}

/** The injected metadata when it describes `pathname`, else null. */
export function injectedSeoForPath(pathname: string): Partial<SeoMeta> | null {
  const injected = readInjectedSeo();
  if (!injected) return null;
  return normalize(injected.path) === normalize(pathname) ? injected.meta : null;
}

function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Test seam: forgets the memoised payload. */
export function resetInjectedSeoCache(): void {
  memo = undefined;
}
