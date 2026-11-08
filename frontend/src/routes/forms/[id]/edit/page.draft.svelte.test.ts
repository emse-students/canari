// @vitest-environment happy-dom
/**
 * THE EDITOR OF A DRAFT (owner, 2026-11-08): it says it is a draft, offers "Publier" beside the save,
 * and its header's "Voir le formulaire" opens a PREVIEW in a new tab; a published form's opens the
 * live page and offers no "Publier".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const route = vi.hoisted(() => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1/edit'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
const api = vi.hoisted(() => ({
  status: 'draft' as 'draft' | 'published',
  publishForm: vi.fn(async () => ({ id: 'f1', status: 'published' })),
  updateForm: vi.fn(async (_id: string, p: any) => ({ id: 'f1', status: api.status, ...p })),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: async () => ({
    id: 'f1',
    title: 'Gala',
    description: '',
    status: api.status,
    items: [{ id: 'q1', label: 'Nom', required: false, type: 'short_text' }],
    currency: 'eur',
    basePrice: 0,
    associationId: null,
  }),
  getSubmissions: async () => [],
  publishForm: api.publishForm,
  updateForm: api.updateForm,
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

const MOUNT_BUDGET_MS = 30_000;
const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function open() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => void unmount(app));
  for (let i = 0; i < 10; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

const byText = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('the editor of a draft', () => {
  it(
    'says it is a draft, previews in a new tab, and publishes after saving',
    async () => {
      api.status = 'draft';
      await open();
      expect(document.querySelector('[data-testid="form-draft-notice"]')).not.toBeNull();
      const view = document.querySelector<HTMLAnchorElement>('[data-testid="form-view-link"]')!;
      expect(view.getAttribute('href')).toBe('/forms/f1?preview=1');
      expect(view.getAttribute('target')).toBe('_blank');
      expect(view.getAttribute('rel')).toBe('noopener');
      byText(m.form_publish_button())!.click();
      await vi.waitFor(() => expect(api.publishForm).toHaveBeenCalledWith('f1'));
      expect(api.updateForm).toHaveBeenCalledTimes(1);
    },
    MOUNT_BUDGET_MS
  );

  it(
    'a published form: the live page, no "Publier"',
    async () => {
      api.status = 'published';
      await open();
      expect(document.querySelector('[data-testid="form-draft-notice"]')).toBeNull();
      expect(document.querySelector('[data-testid="form-view-link"]')!.getAttribute('href')).toBe(
        '/forms/f1'
      );
      expect(byText(m.form_publish_button())).toBeUndefined();
    },
    MOUNT_BUDGET_MS
  );
});
