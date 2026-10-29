// @vitest-environment happy-dom
/**
 * THE BUILDER'S BACK LINK STAYS ON THE PAGE'S ORIGIN, WHATEVER `?returnTo=` CARRIES.
 *
 * `returnTo` is of unknown origin (a link, a bookmark) and is rendered as a plain `<a href>`, which
 * the router does not intercept when it points elsewhere. The value is held to the page's origin by
 * `safeInternalPath`; this asserts the RENDERED link, the thing a reader actually follows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const route = vi.hoisted(() => ({
  page: { params: {}, url: new URL('https://canari.test/forms/create'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listMyAssociations: async () => [],
  getAssociation: () => Promise.reject(new Error('unused')),
}));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/forms/cotisationSettings', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/cotisationSettings')>()),
  cotisationOptionsFor: async () => ({ tiers: [], mayGrant: false }),
}));
vi.mock('$lib/pricing/criteriaOptions', async (orig) => ({
  ...(await orig<typeof import('$lib/pricing/criteriaOptions')>()),
  fetchFormations: async () => [],
}));

import Page from './+page.svelte';

/** Mounting the whole builder costs seconds under a loaded suite; the budget says so. */
const MOUNT_BUDGET_MS = 30_000;
const PAGE_ORIGIN = 'https://canari.test';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Mounts the builder with `returnTo` and returns where its back link resolves. */
async function backLinkFor(returnTo: string): Promise<URL> {
  route.page.url = new URL(`${PAGE_ORIGIN}/forms/create?returnTo=${encodeURIComponent(returnTo)}`);
  const app = mount(Page, { target: document.body });
  mounted.push(() => void unmount(app));
  for (let i = 0; i < 4; i++) {
    await tick();
    flushSync();
  }
  const link = document.querySelector<HTMLAnchorElement>('header a[href]');
  expect(link).not.toBeNull();
  return new URL(link!.getAttribute('href')!, `${PAGE_ORIGIN}/forms/create`);
}

describe('the form builder back link', () => {
  it(
    'leads to the in-app page returnTo names',
    async () => {
      const url = await backLinkFor('/associations/bde/edit/forms');
      expect(url.origin).toBe(PAGE_ORIGIN);
      expect(url.pathname).toBe('/associations/bde/edit/forms');
    },
    MOUNT_BUDGET_MS
  );

  it(
    'stays on the page origin for a returnTo that is not an in-app path',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const TAB = String.fromCharCode(9);
      const LF = String.fromCharCode(10);
      const CR = String.fromCharCode(13);
      const BS = String.fromCharCode(92);
      for (const returnTo of [
        `/${TAB}/x.example/p`,
        `/${LF}/x.example`,
        `/${CR}/x.example`,
        `/${TAB}${BS}x.example`,
        '//x.example',
      ]) {
        const url = await backLinkFor(returnTo);
        expect(url.origin).toBe(PAGE_ORIGIN);
        expect(url.pathname).toBe('/forms');
        mounted.splice(0).forEach((f) => f());
        document.body.innerHTML = '';
      }
    },
    MOUNT_BUDGET_MS
  );
});
