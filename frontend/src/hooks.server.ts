import type { Handle } from '@sveltejs/kit';
import { renderSeoTags, renderSeoTitle } from '$lib/seo/renderHead';
import { resolveServerSeo } from '$lib/seo/serverSeo';
import { SITE } from '$lib/seo/site';

/**
 * Writes the page's Open Graph head into the shell before it is sent.
 *
 * This is the whole reason the web build runs on adapter-node while Tauri stays static. The app is
 * a SPA - `ssr = false`, so not one component renders here - and `SeoHead.svelte` only ever
 * emitted its tags after hydration. No unfurler and no crawler hydrates, so every Canari link
 * shared into a conversation, a channel or a timeline previewed as the bare `app.html`: one title
 * reading "Canari" and one generic description, whatever it pointed at.
 *
 * Two literal markers in `app.html` are substituted, and `hooks.server.test.ts` pins both - a
 * renamed marker would otherwise turn this into a silent no-op:
 *
 * - `<!--canari-seo-->` receives the meta/link block;
 * - `<title>Canari - Mines Saint-Etienne</title>` is REPLACED rather than added to, because two
 *   titles in a document means the first one wins and the static one is the first. It carries the
 *   school for the same reason every other title does: it is what a reader sees whenever the
 *   substitution does not run - the Tauri shell, and the degraded `@app_shell` fallback, which
 *   nginx now answers with 200 and a crawler will therefore index.
 *
 * The static (Tauri) build runs this too, once, while adapter-static prerenders its `index.html`
 * fallback - so the shipped shell carries the generic site-level head and nothing more, no path
 * being known at that point. That is strictly better than the bare `app.html` it had before, and
 * per-request enrichment is by definition only reachable where a server is running.
 */
const SEO_MARKER = '<!--canari-seo-->';
const STATIC_TITLE = `<title>${SITE.defaultTitle}</title>`;

/**
 * SvelteKit reads the error hook from this file, and only from this file. The implementation lives
 * in `$lib/server/handleError` so it can be unit-tested without the SEO imports above - and the
 * `$env/dynamic/private` under them - having to resolve.
 */
export { handleError } from '$lib/server/handleError';

export const handle: Handle = async ({ event, resolve }) => {
  const pathname = event.url.pathname;

  // Assets, API proxies and prerendered files never carry a head worth writing.
  if (pathname.startsWith('/_app/') || pathname.startsWith('/api/')) {
    return resolve(event);
  }

  let seoBlock: string | null = null;
  let seoTitle: string | null = null;
  try {
    const meta = await resolveServerSeo(pathname);
    seoBlock = renderSeoTags(meta, pathname);
    seoTitle = renderSeoTitle(meta);
  } catch (err) {
    // The head is a bonus; the page is the app. Never let one failed lookup cost a navigation.
    console.log('[SEO] head resolution failed for', pathname, err);
  }

  return resolve(event, {
    transformPageChunk: ({ html }) => {
      if (!seoBlock || !seoTitle) return html;
      return html.replace(STATIC_TITLE, seoTitle).replace(SEO_MARKER, seoBlock);
    },
  });
};
