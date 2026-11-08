// @vitest-environment happy-dom
/**
 * THE EDITOR (owner, 2026-11-08): a draft says it is one, previews in a new tab and publishes; every
 * edit is saved as the form's unpublished revision - debounced, at once when the page is hidden -
 * and a published form with such edits offers "Publier les modifications" and "Abandonner".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { AUTOSAVE_DELAY_MS } from '$lib/forms/autosave.svelte';

const route = vi.hoisted(() => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1/edit'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
const api = vi.hoisted(() => ({
  status: 'draft' as 'draft' | 'published',
  revision: { revision: 0, document: null as Record<string, unknown> | null, savedAt: null },
  saveFormDraft: vi.fn(async (_id: string, base: number, _doc: unknown) => ({
    revision: base + 1,
    savedAt: 'now',
  })),
  publishFormDraft: vi.fn(async (_id: string, revision: number) => ({
    id: 'f1',
    status: 'published',
    revision: revision + 1,
  })),
  discardFormDraft: vi.fn(async (_id: string, revision: number) => ({ revision: revision + 1 })),
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
  getFormDraft: async () => api.revision,
  getSubmissions: async () => [],
  saveFormDraft: api.saveFormDraft,
  publishFormDraft: api.publishFormDraft,
  discardFormDraft: api.discardFormDraft,
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
  vi.useRealTimers();
  api.revision = { revision: 0, document: null, savedAt: null };
});

async function settle() {
  for (let i = 0; i < 10; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function open() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => void unmount(app));
  await settle();
}

const byTestId = <T extends Element = HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);
const viewHref = () => byTestId('form-view-link')!.getAttribute('href');
const titleInput = () =>
  [...document.querySelectorAll<HTMLInputElement>('input')].find((i) => i.value === 'Gala')!;

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('the editor', () => {
  it(
    'a draft: says so, previews in a new tab, saves nothing on opening, and publishes',
    async () => {
      api.status = 'draft';
      await open();
      expect(byTestId('form-draft-notice')).not.toBeNull();
      const view = byTestId<HTMLAnchorElement>('form-view-link')!;
      expect(view.getAttribute('href')).toBe('/forms/f1?preview=1');
      expect(view.getAttribute('target')).toBe('_blank');
      expect(view.getAttribute('rel')).toBe('noopener');
      // Opening is not an edit: the editor's own payload round-trips without a save.
      expect(api.saveFormDraft).not.toHaveBeenCalled();
      byTestId<HTMLButtonElement>('publish-button')!.click();
      await vi.waitFor(() => expect(api.publishFormDraft).toHaveBeenCalledWith('f1', 0));
    },
    MOUNT_BUDGET_MS
  );

  it(
    'a published form: the live page, no "Publier" and no save button until something is edited',
    async () => {
      api.status = 'published';
      await open();
      expect(byTestId('form-draft-notice')).toBeNull();
      expect(viewHref()).toBe('/forms/f1');
      expect(byTestId('publish-button')).toBeNull();
      expect(
        [...document.querySelectorAll('button')].some((b) =>
          b.textContent?.includes(m.form_save_changes_button())
        )
      ).toBe(false);
      expect(api.saveFormDraft).not.toHaveBeenCalled();
    },
    MOUNT_BUDGET_MS
  );

  it(
    'saves an edit after the pause, then offers to publish or discard it, and previews it',
    async () => {
      api.status = 'published';
      await open();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      type(titleInput(), 'Gala 2026');
      expect(byTestId('autosave-status')!.dataset.status).toBe('saving');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
      expect(api.saveFormDraft).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(api.saveFormDraft).toHaveBeenCalledTimes(1);
      const [id, base, document] = api.saveFormDraft.mock.calls[0] as [string, number, any];
      expect([id, base, document.title]).toEqual(['f1', 0, 'Gala 2026']);
      expect(byTestId('autosave-status')!.textContent?.trim()).toBe(m.form_autosave_saved());
      expect(byTestId('form-unpublished-notice')).not.toBeNull();
      expect(viewHref()).toBe('/forms/f1?preview=1');
      expect(byTestId('publish-button')!.textContent).toContain(m.form_publish_changes_button());

      byTestId<HTMLButtonElement>('discard-changes')!.click();
      await vi.waitFor(() => expect(api.discardFormDraft).toHaveBeenCalledWith('f1', 1));
      await settle();
      // Back to the form as published, nothing to publish, the live page again.
      expect(titleInput()).toBeDefined();
      expect(byTestId('publish-button')).toBeNull();
      expect(viewHref()).toBe('/forms/f1');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
      expect(api.saveFormDraft).toHaveBeenCalledTimes(1);
    },
    MOUNT_BUDGET_MS
  );

  it(
    'saves at once when the page is hidden, without waiting for the pause',
    async () => {
      api.status = 'published';
      await open();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      type(titleInput(), 'Gala hidden');
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      await settle();
      expect(api.saveFormDraft).toHaveBeenCalledTimes(1);
      expect((api.saveFormDraft.mock.calls[0] as any[])[2].title).toBe('Gala hidden');
    },
    MOUNT_BUDGET_MS
  );

  it(
    'opens on the unpublished revision, and publishes it by its number',
    async () => {
      api.status = 'published';
      api.revision = {
        revision: 7,
        document: {
          title: 'Gala (revision)',
          description: '',
          basePrice: 0,
          currency: 'eur',
          items: [{ id: 'q1', label: 'Nom', required: false, type: 'short_text' }],
        },
        savedAt: null,
      };
      await open();
      expect(
        [...document.querySelectorAll<HTMLInputElement>('input')].some(
          (i) => i.value === 'Gala (revision)'
        )
      ).toBe(true);
      expect(byTestId('form-unpublished-notice')).not.toBeNull();
      expect(viewHref()).toBe('/forms/f1?preview=1');
      byTestId<HTMLButtonElement>('publish-button')!.click();
      await vi.waitFor(() => expect(api.publishFormDraft).toHaveBeenCalledWith('f1', 7));
      expect(api.saveFormDraft).not.toHaveBeenCalled();
    },
    MOUNT_BUDGET_MS
  );
});
