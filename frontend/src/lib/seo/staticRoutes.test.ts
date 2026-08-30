import { describe, expect, it } from 'vitest';

import { isStaticPageRoute } from '$lib/seo/staticRoutes';

/**
 * The set `isStaticPageRoute` reads is DERIVED from the route tree, so nothing states its members
 * anywhere. These are the collisions it was written for, and they are the reason it exists: the
 * enrichment table matches on a regex, and a regex has none of SvelteKit's precedence.
 */
describe('isStaticPageRoute', () => {
  it('THE DEFECT: the three static pages under /forms are pages, not form ids', () => {
    // `/forms/success` is rendered once per completed payment, and social-service answered 500
    // every time because Postgres was handed the word `success` for a `uuid` column.
    expect(isStaticPageRoute('/forms/success')).toBe(true);
    expect(isStaticPageRoute('/forms/cancel')).toBe(true);
    expect(isStaticPageRoute('/forms/create')).toBe(true);
  });

  it('the creation page under /associations is a page, not a slug', () => {
    expect(isStaticPageRoute('/associations/new')).toBe(true);
  });

  it('a real id is still enriched - the guard must not swallow the whole table', () => {
    expect(isStaticPageRoute('/forms/3f2b9c14-7c5e-4a90-9d1f-0b5f6a2e8c31')).toBe(false);
    expect(isStaticPageRoute('/posts/3f2b9c14-7c5e-4a90-9d1f-0b5f6a2e8c31')).toBe(false);
    expect(isStaticPageRoute('/associations/bde')).toBe(false);
  });

  it('a trailing slash names the same page, because the enricher patterns accept one', () => {
    expect(isStaticPageRoute('/forms/success/')).toBe(true);
    expect(isStaticPageRoute('/associations/new/')).toBe(true);
  });

  it('the parent listings and the root are static too', () => {
    expect(isStaticPageRoute('/')).toBe(true);
    expect(isStaticPageRoute('/forms')).toBe(true);
    expect(isStaticPageRoute('/associations')).toBe(true);
  });

  it('an unknown path belongs to no page', () => {
    expect(isStaticPageRoute('/forms/success/extra')).toBe(false);
    expect(isStaticPageRoute('/nothing-here')).toBe(false);
  });
});
