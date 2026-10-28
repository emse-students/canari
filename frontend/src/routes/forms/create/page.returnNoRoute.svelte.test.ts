// @vitest-environment happy-dom
/**
 * A SAVED FORM LEAVES ITS BUILDER, WHEREVER `?returnTo=` POINTS (SvelteKit 3, #2613).
 *
 * `returnTo` is of unknown origin (a link, a bookmark). Kit 3's `goto` rejects a path no route
 * matches, and the builder called it without awaiting: the form was created, the builder stayed on
 * screen with its save button live again, and a second press created a second form. The return
 * now goes through `gotoAppPath`, which loads such a path as a document for the server to answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const route = vi.hoisted(() => ({
  page: { params: {}, url: new URL('https://canari.test/forms/create'), state: {} },
}));
vi.mock('$app/state', () => route);
const nav = vi.hoisted(() => ({ goto: vi.fn(async (_href: string, _opts?: unknown) => {}) }));
vi.mock('$app/navigation', () => nav);
const api = vi.hoisted(() => ({ createForm: vi.fn(async () => ({ id: 'f-new' })) }));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  createForm: api.createForm,
}));
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

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  nav.goto.mockClear();
  api.createForm.mockClear();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function saveReturningTo(returnTo: string) {
  route.page.url = new URL(
    `https://canari.test/forms/create?returnTo=${encodeURIComponent(returnTo)}`
  );
  const app = mount(Page, { target: document.body });
  mounted.push(() => void unmount(app));
  await settle();
  const title = document.querySelector<HTMLInputElement>(
    `input[placeholder="${m.form_title_placeholder()}"]`
  )!;
  title.value = 'Soiree';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const save = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.form_save_button())
  )!;
  save.click();
  await settle();
}

describe('the form builder, once the form is saved', () => {
  it('routes back to a page this build has', async () => {
    await saveReturningTo('/associations/bde/edit/forms');
    expect(api.createForm).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(nav.goto).toHaveBeenCalledWith('/associations/bde/edit/forms', {})
    );
  });

  it('loads a page this build lacks as a document rather than staying put', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    await saveReturningTo('/a-page-this-build-lost');
    expect(api.createForm).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/a-page-this-build-lost'));
    expect(nav.goto).not.toHaveBeenCalled();
  });
});
