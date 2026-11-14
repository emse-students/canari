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
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The association picker's panel leaves by an outro when an option is chosen.
afterAll(adoptTransitionAnimations());

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
const assos = vi.hoisted(() => ({
  list: [] as { id: string; name: string; type?: string; permissions?: number }[],
}));
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

/** Opens the association picker and picks the option labelled `label`. */
async function pickAssociation(label: string) {
  document.querySelector<HTMLButtonElement>('#association-select')!.click();
  await settle();
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (o) => o.textContent?.trim() === label
  );
  expect(option, `no option ${label}`).toBeDefined();
  option!.click();
  await settle();
}

/** Types `value` into the title. */
async function typeTitle(value: string) {
  const title = document.querySelector<HTMLInputElement>(
    `input[placeholder="${m.form_title_placeholder()}"]`
  )!;
  title.value = value;
  title.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

/** The association each create named, in order. */
const createdUnder = () =>
  api.createForm.mock.calls.map(([p]) => (p as { associationId?: string }).associationId);
/** The association the last saved revision carries. */
const lastSavedAssociation = () =>
  (api.saveFormDraft.mock.calls.at(-1)![2] as { associationId?: string }).associationId;

// THE AUTOSAVE MUST NOT LOCK THE OWNER (owner, 2026-11-09: "la sauvegarde auto empeche de modifier
// le proprietaire du formulaire"). The first autosave creates the draft under the association picked
// then; the picker used to shut from that moment. A later choice now rides in the revision, and the
// publication moves the draft (`FormsService.associationAfterEdit`).
describe('the association of a draft being built', () => {
  // The builder manages both associations' forms (MANAGE_FORMS = 16, owner 2026-11-14).
  const BDE = { id: 'a1', name: 'BDE', type: 'association', permissions: 16 };
  const BDS = { id: 'a2', name: 'BDS', type: 'association', permissions: 16 };

  async function openBuilder() {
    route.page.url = new URL('https://canari.test/forms/create?association=a1');
    const app = mount(Page, { target: document.body });
    mounted.push(() => void unmount(app));
    await settle();
    await vi.waitFor(() => expect(document.querySelector('#association-select')).not.toBeNull());
  }

  it(
    'stays changeable after the first autosave: the new choice is saved, and two quick edits keep it',
    async () => {
      assos.list = [BDE, BDS];
      await openBuilder();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await typeTitle('Soiree');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(createdUnder()).toEqual(['a1']);
        const picker = document.querySelector<HTMLButtonElement>('#association-select')!;
        expect(picker.disabled).toBe(false);

        // Two quick edits, inside one pause: the association, then the title.
        await pickAssociation('BDS');
        await typeTitle('Soiree BDS');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(api.saveFormDraft).toHaveBeenLastCalledWith(
          serverId(),
          1,
          expect.objectContaining({ title: 'Soiree BDS', associationId: 'a2' }),
          expect.any(String),
          { leaving: false }
        );
        // The draft exists: never created again, under either association.
        expect(createdUnder()).toEqual(['a1']);
        expect(document.querySelector('[data-testid="form-association-pending"]')).not.toBeNull();

        // A later edit does not put the old association back.
        await typeTitle('Soiree BDS 2');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(lastSavedAssociation()).toBe('a2');

        // And back to personal: said, not left out (an absent field would mean "leave it").
        await pickAssociation(m.form_association_none());
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(lastSavedAssociation()).toBe('');
      } finally {
        vi.useRealTimers();
        assos.list = [];
      }
    },
    MOUNT_BUDGET_MS
  );

  it(
    'a create that reached no answer is replayed naming the association it was SENT with, the revision the new one',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      assos.list = [BDE, BDS];
      api.createForm.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await openBuilder();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await typeTitle('Soiree');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(createdUnder()).toEqual(['a1']);
        // It may have stored the form under a1 all the same; the builder still chooses.
        await pickAssociation('BDS');
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(createdUnder()).toEqual(['a1', 'a1']);
        expect(lastSavedAssociation()).toBe('a2');
      } finally {
        vi.useRealTimers();
        assos.list = [];
      }
    },
    MOUNT_BUDGET_MS
  );

  it(
    'after a definite refusal of that create (nothing stored), the next create names the choice of then',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      assos.list = [BDE, BDS];
      api.createForm.mockRejectedValueOnce(new SocialApiError('Forbidden', null, 403));
      await openBuilder();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await typeTitle('Soiree');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(createdUnder()).toEqual(['a1']);
        await pickAssociation('BDS');
        await typeTitle('Soiree BDS');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(createdUnder()).toEqual(['a1', 'a2']);
        expect(document.querySelector('[data-testid="form-association-pending"]')).toBeNull();
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
