// @vitest-environment happy-dom
/**
 * A SAVED FORM LEAVES ITS BUILDER, WHEREVER `?returnTo=` POINTS (SvelteKit 3, #2613).
 *
 * `returnTo` is of unknown origin (a link, a bookmark). Kit 3's `goto` rejects a path no route
 * matches, and the builder called it without awaiting: the form was created, the builder stayed on
 * screen with its save button live again, and a second press created a second form. The return
 * now goes through `gotoAppPath`, which loads such a path as a document (the server on the web, the
 * embedded build on a phone).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const route = vi.hoisted(() => ({
  page: { params: {}, url: new URL('https://canari.test/forms/create'), state: {} },
}));
vi.mock('$app/state', () => route);
const nav = vi.hoisted(() => ({
  goto: vi.fn(async (_href: string, _opts?: unknown) => {}),
  beforeNavigate: vi.fn(),
}));
vi.mock('$app/navigation', () => nav);
const api = vi.hoisted(() => ({
  // The server mints the form's id; a create sent again under the same key answers the same form.
  createForm: vi.fn(async (payload: any) => ({
    id: payload.clientCreateId ? `f-of-${payload.clientCreateId}` : 'f-new',
  })),
  saveFormDraft: vi.fn(async (_id: string, base: number, _doc: any, _saveId?: string) => ({
    revision: base + 1,
    savedAt: 'now',
  })),
  publishFormDraft: vi.fn(async (id: string, revision: number) => ({
    id,
    status: 'published',
    revision: revision + 1,
  })),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  createForm: api.createForm,
  saveFormDraft: api.saveFormDraft,
  publishFormDraft: api.publishFormDraft,
}));
const assos = vi.hoisted(() => ({ list: [] as { id: string; name: string }[] }));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listMyAssociations: async () => assos.list,
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

const caps = vi.hoisted(() => ({ formDrafts: true as boolean | null }));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/user')>()),
  currentUserId: () => 'u1',
}));
const device = vi.hoisted(() => ({ copies: new Map<string, unknown>() }));
vi.mock('$lib/forms/draftCopies', () => ({
  holdFormEditor: () => () => {},
  formDraftCopyStore: () => ({
    rekey: async (from: string, to: string) => {
      const copy = device.copies.get(from);
      if (!copy) return;
      device.copies.delete(from);
      device.copies.set(to, copy);
    },
  }),
  deviceCopyOf: (
    _user: string,
    ids: () => { formId: string | null; clientCreateId: string | null }
  ) => {
    const keys = () => [ids().formId, ids().clientCreateId].filter((k): k is string => !!k);
    return {
      keep: async (baseRevision: number, saveId: string, document: unknown) =>
        void device.copies.set(keys()[0]!, { baseRevision, saveId, document }),
      sent: async () => keys().forEach((k) => device.copies.delete(k)),
      drop: async () => keys().forEach((k) => device.copies.delete(k)),
    };
  },
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverFormDrafts: () => caps.formDrafts,
}));

import Page from './+page.svelte';
import { AUTOSAVE_DELAY_MS } from '$lib/forms/autosave.svelte';
import { SocialApiError } from '$lib/associations/api';

/** The create key the page minted for its draft, as its first create carried it. */
const createKey = () =>
  (api.createForm.mock.calls[0]![0] as { clientCreateId: string }).clientCreateId;
/** The id the server minted for that create. */
const serverId = () => `f-of-${createKey()}`;

/**
 * Mounting the whole builder is the cost of these tests: about 5 s for the first under a loaded
 * suite (the component graph is transformed on that first mount), well under 1 s after. The budget
 * says so rather than the 5 s default, which the first test met and missed.
 */
const MOUNT_BUDGET_MS = 30_000;

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  nav.goto.mockClear();
  api.createForm.mockClear();
  api.saveFormDraft.mockClear();
  device.copies.clear();
  api.publishFormDraft.mockClear();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function saveReturningTo(returnTo: string, buttonLabel = m.form_publish_button()) {
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
    b.textContent?.includes(buttonLabel)
  )!;
  save.click();
  await settle();
}

describe('the form builder saves as it is typed', () => {
  it(
    'creates the draft at the first pause after a title, then saves every edit as its revision',
    async () => {
      route.page.url = new URL('https://canari.test/forms/create');
      const app = mount(Page, { target: document.body });
      mounted.push(() => void unmount(app));
      await settle();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const title = document.querySelector<HTMLInputElement>(
          `input[placeholder="${m.form_title_placeholder()}"]`
        )!;
        title.value = 'Soiree';
        title.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        expect(api.createForm).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(api.createForm).toHaveBeenCalledTimes(1);
        expect(createKey()).toMatch(/^[0-9a-f-]{36}$/);
        expect(api.saveFormDraft).toHaveBeenCalledWith(
          serverId(),
          0,
          expect.objectContaining({ title: 'Soiree' }),
          expect.any(String),
          { leaving: false }
        );
        // Landed: nothing is owed on the device.
        expect(device.copies.size).toBe(0);
        expect(document.querySelector('[data-testid="autosave-status"]')?.textContent?.trim()).toBe(
          m.form_autosave_saved()
        );
        title.value = 'Soiree 2';
        title.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        // The draft exists: no second creation, the next revision on the first.
        expect(api.createForm).toHaveBeenCalledTimes(1);
        expect(api.saveFormDraft).toHaveBeenLastCalledWith(
          serverId(),
          1,
          expect.objectContaining({ title: 'Soiree 2' }),
          expect.any(String),
          { leaving: false }
        );
      } finally {
        vi.useRealTimers();
      }
    },
    MOUNT_BUDGET_MS
  );

  it(
    'a create whose answer was lost is sent again as the SAME create - never a second draft',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.createForm.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      route.page.url = new URL('https://canari.test/forms/create');
      const app = mount(Page, { target: document.body });
      mounted.push(() => void unmount(app));
      await settle();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const title = document.querySelector<HTMLInputElement>(
          `input[placeholder="${m.form_title_placeholder()}"]`
        )!;
        title.value = 'Soiree';
        title.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        // Kept on the device meanwhile, under the create key.
        expect(device.copies.has(createKey())).toBe(true);
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        const keys = api.createForm.mock.calls.map(
          ([p]) => (p as { clientCreateId: string }).clientCreateId
        );
        expect(keys).toEqual([createKey(), createKey()]);
        expect(api.saveFormDraft).toHaveBeenCalledTimes(1);
        expect(device.copies.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
    MOUNT_BUDGET_MS
  );
});

describe('the association of a create sent', () => {
  it(
    'is fixed from the FIRST create sent, answered or not: its replay must name the same one',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      assos.list = [{ id: 'a1', name: 'BDE' }];
      api.createForm.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      route.page.url = new URL('https://canari.test/forms/create');
      const app = mount(Page, { target: document.body });
      mounted.push(() => void unmount(app));
      await settle();
      const picker = () => document.querySelector<HTMLElement>('#association-select');
      const shut = () =>
        picker()?.hasAttribute('disabled') === true ||
        picker()?.getAttribute('aria-disabled') === 'true';
      await vi.waitFor(() => expect(picker()).not.toBeNull());
      expect(shut()).toBe(false);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const title = document.querySelector<HTMLInputElement>(
          `input[placeholder="${m.form_title_placeholder()}"]`
        )!;
        title.value = 'Soiree';
        title.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        // The create reached no answer: it may have stored the form all the same.
        expect(api.createForm).toHaveBeenCalledTimes(1);
        expect(shut()).toBe(true);
      } finally {
        vi.useRealTimers();
        assos.list = [];
      }
    },
    MOUNT_BUDGET_MS
  );
  it(
    'opens again after a definite refusal of that create: nothing was stored under it',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      assos.list = [{ id: 'a1', name: 'BDE' }];
      api.createForm.mockRejectedValueOnce(new SocialApiError('Forbidden', null, 403));
      route.page.url = new URL('https://canari.test/forms/create');
      const app = mount(Page, { target: document.body });
      mounted.push(() => void unmount(app));
      await settle();
      const picker = () => document.querySelector<HTMLElement>('#association-select');
      const shut = () =>
        picker()?.hasAttribute('disabled') === true ||
        picker()?.getAttribute('aria-disabled') === 'true';
      await vi.waitFor(() => expect(picker()).not.toBeNull());
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const title = document.querySelector<HTMLInputElement>(
          `input[placeholder="${m.form_title_placeholder()}"]`
        )!;
        title.value = 'Soiree';
        title.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(api.createForm).toHaveBeenCalledTimes(1);
        expect(shut()).toBe(false);
      } finally {
        vi.useRealTimers();
        assos.list = [];
      }
    },
    MOUNT_BUDGET_MS
  );
});

describe('the form builder, once the form is saved', () => {
  it(
    'routes back to a page this build has',
    async () => {
      await saveReturningTo('/associations/bde/edit/forms');
      expect(api.createForm).toHaveBeenCalledTimes(1);
      // Created as a draft, its revision saved, then published: "Publier" leaves the builder.
      expect(api.createForm).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true, title: 'Soiree' })
      );
      const [id, , document] = api.saveFormDraft.mock.calls.at(-1)!;
      expect([id, document.title]).toEqual([serverId(), 'Soiree']);
      await vi.waitFor(() =>
        expect(api.publishFormDraft).toHaveBeenCalledWith(
          serverId(),
          api.saveFormDraft.mock.calls.length
        )
      );
      await vi.waitFor(() =>
        expect(nav.goto).toHaveBeenCalledWith('/associations/bde/edit/forms', {})
      );
    },
    MOUNT_BUDGET_MS
  );

  it(
    'an estate older than drafts: one save that publishes, no draft flag, no publish route',
    async () => {
      caps.formDrafts = false;
      try {
        await saveReturningTo('/associations/bde/edit/forms', m.form_save_button());
        expect(api.createForm).toHaveBeenCalledTimes(1);
        expect(api.createForm.mock.calls[0]).not.toHaveProperty('0.draft');
        // Nor a client id: an older server's validation would strip it, and it is not needed.
        expect(api.createForm.mock.calls[0]).not.toHaveProperty('0.id');
        expect(api.saveFormDraft).not.toHaveBeenCalled();
        expect(api.publishFormDraft).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(nav.goto).toHaveBeenCalledWith('/associations/bde/edit/forms', {})
        );
      } finally {
        caps.formDrafts = true;
      }
    },
    MOUNT_BUDGET_MS
  );

  it(
    'loads a page this build lacks as a document rather than staying put',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
      await saveReturningTo('/a-page-this-build-lost');
      expect(api.createForm).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(assign).toHaveBeenCalledWith(
          new URL('/a-page-this-build-lost', window.location.href).href
        )
      );
      expect(nav.goto).not.toHaveBeenCalled();
    },
    MOUNT_BUDGET_MS
  );
});
