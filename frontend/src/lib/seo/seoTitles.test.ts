import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { allMarkup } from '$lib/styles/markupSources';
import { PRIVATE_PREFIXES, resolveSeoForPath } from '$lib/seo/resolve';
import { PUBLIC_SITEMAP_ENTRIES } from '$lib/seo/sitemap';
import { SITE } from '$lib/seo/site';
import { STATIC_PAGE_ROUTES } from '$lib/seo/staticRoutes';

/**
 * EVERY PAGE NAMES ITSELF, AND EXACTLY ONE THING NAMES IT.
 *
 * Both halves failed on dev on 2026-09-14. Twenty of the forty static routes resolved no title of
 * their own and opened a tab reading "Canari - Mines Saint-Etienne" - all thirteen admin pages,
 * `/settings`, `/profile`, `/events`, `/directory`, `/lists`, `/documents` and `/account/purchases`.
 * Ten OTHER pages had each worked around that by rendering a `<svelte:head><title>` of their own,
 * which wins over the one `SeoHead` renders while `og:title` and `twitter:title` keep the layout's:
 * `/legal/cgu` served a document titled "Conditions Generales d'Utilisation" whose own preview said
 * "Conditions generales d'utilisation", because the two spellings lived in two files.
 *
 * The route set is DERIVED from the route tree, so a page added tomorrow is asked the same question
 * without anybody adding it here.
 */
const ROOT = process.cwd();

/**
 * The two routes whose title is `SITE.defaultTitle`, deliberately.
 *
 * `/` is the home page, and `site.ts` says why the default title is written for it before anything
 * else. `/app-shell` is what nginx serves when the SSR container is unreachable - the app booting
 * on whatever URL was asked for, so it has no content and no canonical URL of its own, which is
 * also why `robots.txt` has always disallowed it.
 *
 * Nothing else may join them without that sentence being written here.
 */
const TITLED_BY_THE_SITE = new Set(['/', '/app-shell']);

describe('every static route resolves a title of its own', () => {
  const routes = [...STATIC_PAGE_ROUTES].sort();

  it('the route set is derived, so it is not empty and it holds the pages this file names', () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContain('/admin/storage');
    expect(routes).toContain('/settings');
    expect(routes).toContain('/directory');
  });

  it.each(routes.filter((r) => !TITLED_BY_THE_SITE.has(r)))('%s', (route) => {
    const title = resolveSeoForPath(route).title.trim();
    expect(title).not.toBe('');
    expect(title).not.toBe(SITE.defaultTitle);
  });

  it('the two that keep the site title keep it', () => {
    for (const route of TITLED_BY_THE_SITE) {
      expect(resolveSeoForPath(route).title).toBe(SITE.defaultTitle);
    }
  });

  it('an admin page is told apart from the public page of the same name', () => {
    expect(resolveSeoForPath('/admin/associations').title).not.toBe(
      resolveSeoForPath('/associations').title
    );
  });
});

describe('nothing but SeoHead writes a document title', () => {
  it('no page or component renders its own <title>', () => {
    const offenders = allMarkup(join(ROOT, 'src'))
      .filter(({ file }) => file !== join('lib', 'components', 'seo', 'SeoHead.svelte'))
      .filter(({ body }) => /<title[\s>]/.test(body))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

describe('a page is private to one list or to neither', () => {
  it('no page offered in the sitemap sits under a private prefix', () => {
    const contradictions = PUBLIC_SITEMAP_ENTRIES.filter((entry) =>
      PRIVATE_PREFIXES.some((p) => entry.path === p || entry.path.startsWith(`${p}/`))
    ).map((entry) => entry.path);

    expect(contradictions).toEqual([]);
  });

  it('a page under a private prefix is noindex, and a page in the sitemap is not', () => {
    expect(resolveSeoForPath('/directory').noindex).toBe(true);
    expect(resolveSeoForPath('/admin/users').noindex).toBe(true);
    for (const entry of PUBLIC_SITEMAP_ENTRIES) {
      expect(resolveSeoForPath(entry.path).noindex ?? false).toBe(false);
    }
  });
});
