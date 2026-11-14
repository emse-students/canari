// @vitest-environment happy-dom
/**
 * THE EDITOR (owner, 2026-11-08): a draft says it is one, previews in a new tab and publishes; every
 * edit is saved as the form's unpublished revision - debounced, at once when the page is hidden -
 * and a published form with such edits offers "Publier les modifications" and "Abandonner". An edit
 * is saved when the editor is torn down by an in-app navigation, kept on the device until a save
 * lands, and an editor reopened sends what a closed one left. An estate older than revisions gets
 * the editor it always had.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { AUTOSAVE_DELAY_MS } from '$lib/forms/autosave.svelte';
import { dismissToast, toastStore } from '$lib/stores/toast.svelte';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

// The association picker's panel leaves by an outro when an option is chosen.
afterAll(adoptTransitionAnimations());

const route = vi.hoisted(() => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1/edit'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}), beforeNavigate: vi.fn() }));
const api = vi.hoisted(() => ({
  status: 'draft' as 'draft' | 'published',
  associationId: null as string | null,
  revision: {
    revision: 0,
    document: null as Record<string, unknown> | null,
    savedAt: null,
    saveId: null as string | null,
  },
  getFormDraft: vi.fn(),
  updateForm: vi.fn(async (_id: string, _payload: unknown) => ({ id: 'f1' })),
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
    associationId: api.associationId,
  }),
  getFormDraft: api.getFormDraft.mockImplementation(async () => api.revision),
  updateForm: api.updateForm,
  getSubmissions: async () => [],
  saveFormDraft: api.saveFormDraft,
  publishFormDraft: api.publishFormDraft,
  discardFormDraft: api.discardFormDraft,
}));
const caps = vi.hoisted(() => ({ formDrafts: true as boolean | null }));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverFormDrafts: () => caps.formDrafts,
}));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/user')>()),
  currentUserId: () => 'u1',
}));
/** The device copies, in memory: what a closed editor left, and what this one keeps. */
const device = vi.hoisted(() => ({
  copies: new Map<
    string,
    {
      key: string;
      formId: string;
      clientCreateId: string | null;
      baseRevision: number;
      saveId: string;
      after: string[];
      document: any;
    }
  >(),
}));
vi.mock('$lib/forms/draftCopies', async (orig) => ({
  // `copyAgainst` is the real one: what the editor does with a copy is what these tests pin.
  ...(await orig<typeof import('$lib/forms/draftCopies')>()),
  holdFormEditor: () => () => {},
  formDraftCopyStore: () => ({
    get: async (id: string) => device.copies.get(id) ?? null,
    delete: async (keys: string[]) => keys.forEach((k) => device.copies.delete(k)),
    deleteIfSent: async (keys: string[], saveId: string) =>
      keys.some((k) => device.copies.get(k)?.saveId === saveId && device.copies.delete(k)),
  }),
  deviceCopyOf: (_user: string, ids: () => { formId: string | null }) => {
    const formId = () => ids().formId!;
    return {
      keep: async (baseRevision: number, saveId: string, document: unknown, after: string[]) =>
        void device.copies.set(formId(), {
          key: formId(),
          formId: formId(),
          clientCreateId: null,
          baseRevision,
          saveId,
          after,
          document,
        }),
      sent: async (saveId: string) => {
        if (device.copies.get(formId())?.saveId === saveId) device.copies.delete(formId());
      },
      drop: async () => void device.copies.delete(formId()),
    };
  },
}));
const ASSOS = vi.hoisted(() => [
  // The builder manages both associations' forms (MANAGE_FORMS = 16, owner 2026-11-14).
  { id: 'a1', name: 'BDE', type: 'association', permissions: 16 },
  { id: 'a2', name: 'BDS', type: 'association', permissions: 16 },
]);
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listMyAssociations: async () => ASSOS,
  getAssociation: async (id: string) => ASSOS.find((a) => a.id === id)!,
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
  api.saveFormDraft.mockReset();
  api.saveFormDraft.mockImplementation(async (_id: string, base: number) => ({
    revision: base + 1,
    savedAt: 'now',
  }));
  vi.useRealTimers();
  api.revision = { revision: 0, document: null, savedAt: null, saveId: null };
  api.associationId = null;
  caps.formDrafts = true;
  device.copies.clear();
  toastStore.toasts.forEach((t) => dismissToast(t.id));
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
      await vi.waitFor(() => expect(api.publishFormDraft).toHaveBeenCalledWith('f1', 0, false));
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
        saveId: null,
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
      await vi.waitFor(() => expect(api.publishFormDraft).toHaveBeenCalledWith('f1', 7, false));
      expect(api.saveFormDraft).not.toHaveBeenCalled();
    },
    MOUNT_BUDGET_MS
  );

  it(
    'an in-app navigation ("Retour", a link): the edit typed just before is saved, not dropped',
    async () => {
      api.status = 'published';
      await open();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      type(titleInput(), 'Gala, then Retour');
      // The page goes with no pagehide: the editor is torn down.
      mounted.splice(0).forEach((f) => f());
      await vi.advanceTimersByTimeAsync(0);
      expect(api.saveFormDraft).toHaveBeenCalledTimes(1);
      expect((api.saveFormDraft.mock.calls[0] as any[])[2].title).toBe('Gala, then Retour');
    },
    MOUNT_BUDGET_MS
  );

  it(
    'keeps the edit on the device until it lands, and a reopened editor sends what a closed one left',
    async () => {
      api.status = 'published';
      api.saveFormDraft.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await open();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      type(titleInput(), 'Gala offline');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
      await settle();
      const kept = device.copies.get('f1')!;
      expect(kept).toMatchObject({ baseRevision: 0, document: { title: 'Gala offline' } });
      // The tab is closed offline, then the editor opened again: it opens on the copy and sends it
      // as the SAME save.
      api.saveFormDraft.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      mounted.splice(0).forEach((f) => f());
      vi.useRealTimers();
      await settle();
      api.saveFormDraft.mockClear();
      await open();
      await vi.waitFor(() =>
        expect(
          [...document.querySelectorAll<HTMLInputElement>('input')].some(
            (i) => i.value === 'Gala offline'
          )
        ).toBe(true)
      );
      await vi.waitFor(() =>
        expect(api.saveFormDraft).toHaveBeenCalledWith(
          'f1',
          0,
          expect.objectContaining({ title: 'Gala offline' }),
          kept.saveId,
          { leaving: false }
        )
      );
      await vi.waitFor(() => expect(device.copies.has('f1')).toBe(false));
    },
    MOUNT_BUDGET_MS
  );

  it(
    "a device copy the server already holds (its save id is the revision's) is cleared, not sent again",
    async () => {
      api.status = 'published';
      api.revision = {
        revision: 3,
        document: { title: 'Landed', basePrice: 0, currency: 'eur', items: [] },
        savedAt: null,
        saveId: 'landed-save',
      };
      device.copies.set('f1', {
        key: 'f1',
        formId: 'f1',
        clientCreateId: null,
        after: [],
        baseRevision: 2,
        saveId: 'landed-save',
        document: { title: 'Landed', basePrice: 0, currency: 'eur', items: [] },
      });
      await open();
      expect(device.copies.has('f1')).toBe(false);
      expect(api.saveFormDraft).not.toHaveBeenCalled();
    },
    MOUNT_BUDGET_MS
  );

  it(
    'a copy whose predecessor landed unanswered (lost answer, more typing, app closed) is re-based and sent',
    async () => {
      api.status = 'published';
      // The server holds what save s1 wrote; its answer never reached the closed page.
      api.revision = {
        revision: 3,
        document: { title: 'One', basePrice: 0, currency: 'eur', items: [] },
        savedAt: null,
        saveId: 's1',
      };
      device.copies.set('f1', {
        key: 'f1',
        formId: 'f1',
        clientCreateId: null,
        after: ['s1'],
        baseRevision: 2,
        saveId: 's2',
        document: { title: 'One then two', basePrice: 0, currency: 'eur', items: [] },
      });
      await open();
      await vi.waitFor(() =>
        expect(api.saveFormDraft).toHaveBeenCalledWith(
          'f1',
          3,
          expect.objectContaining({ title: 'One then two' }),
          's2',
          { leaving: false }
        )
      );
      expect(toastStore.toasts).toEqual([]);
    },
    MOUNT_BUDGET_MS
  );

  it(
    'a copy another writer moved past is dropped, and the member is told which form',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.status = 'published';
      api.revision = {
        revision: 5,
        document: { title: 'Theirs', basePrice: 0, currency: 'eur', items: [] },
        savedAt: null,
        saveId: 'other-device',
      };
      device.copies.set('f1', {
        key: 'f1',
        formId: 'f1',
        clientCreateId: null,
        after: [],
        baseRevision: 2,
        saveId: 'mine',
        document: { title: 'Gala mine', basePrice: 0, currency: 'eur', items: [] },
      });
      await open();
      await vi.waitFor(() => expect(device.copies.has('f1')).toBe(false));
      expect(api.saveFormDraft).not.toHaveBeenCalled();
      expect(toastStore.toasts.map((t) => t.message)).toContain(
        m.form_draft_copy_dropped({ title: 'Gala mine' })
      );
    },
    MOUNT_BUDGET_MS
  );

  it(
    'a form written outside its revision: refused in words, then published only once confirmed',
    async () => {
      api.status = 'published';
      api.revision = {
        revision: 2,
        document: { title: 'Gala (revision)', basePrice: 0, currency: 'eur', items: [] },
        savedAt: null,
        saveId: null,
      };
      const { SocialApiError } = await import('$lib/associations/api');
      api.publishFormDraft.mockRejectedValueOnce(
        new SocialApiError('changed', 'FORM_CHANGED_SINCE_REVISION', 409)
      );
      await open();
      byTestId<HTMLButtonElement>('publish-button')!.click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(m.form_changed_since_revision_refusal())
      );
      const confirm = byTestId<HTMLButtonElement>('publish-button')!;
      expect(confirm.textContent).toContain(m.form_publish_overwrite_button());
      confirm.click();
      await vi.waitFor(() => expect(api.publishFormDraft).toHaveBeenLastCalledWith('f1', 2, true));
    },
    MOUNT_BUDGET_MS
  );

  it(
    '"Voir le formulaire" saves the pending edit before the preview opens',
    async () => {
      api.status = 'published';
      const tab = { opener: {} as unknown, location: { href: '' } };
      const openTab = vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
      await open();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      type(titleInput(), 'Gala previewed');
      byTestId<HTMLAnchorElement>('form-view-link')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      expect(api.saveFormDraft).toHaveBeenCalledTimes(1);
      expect(openTab).toHaveBeenCalledWith('', '_blank');
      expect([tab.opener, tab.location.href]).toEqual([null, '/forms/f1?preview=1']);
    },
    MOUNT_BUDGET_MS
  );

  it(
    'an estate older than revisions: no revision is asked, and "Enregistrer" writes the form',
    async () => {
      caps.formDrafts = false;
      api.status = 'published';
      await open();
      expect(api.getFormDraft).not.toHaveBeenCalled();
      expect(byTestId('autosave-status')).toBeNull();
      type(titleInput(), 'Gala old server');
      const save = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes(m.form_save_changes_button())
      )!;
      save.click();
      await vi.waitFor(() =>
        expect(api.updateForm).toHaveBeenCalledWith(
          'f1',
          expect.objectContaining({ title: 'Gala old server' })
        )
      );
      expect(api.saveFormDraft).not.toHaveBeenCalled();
    },
    MOUNT_BUDGET_MS
  );

  // THE AUTOSAVE MUST NOT LOCK THE OWNER (owner, 2026-11-09). A draft's association is its
  // builder's choice until publication; a published form's stays, and the editor says why.
  describe('the association', () => {
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
    const savedDocuments = () =>
      api.saveFormDraft.mock.calls.map((c) => (c as unknown[])[2] as Record<string, unknown>);

    it(
      'of a draft: changed after an autosave, saved, and kept through a quick second edit',
      async () => {
        api.status = 'draft';
        api.associationId = 'a1';
        await open();
        await vi.waitFor(() =>
          expect(document.querySelector('#association-select')).not.toBeNull()
        );
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        // An autosave lands first: the draft is not locked by it.
        type(titleInput(), 'Gala 1');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(savedDocuments().at(-1)).toMatchObject({ title: 'Gala 1', associationId: 'a1' });

        await pickAssociation('BDS');
        const title = [...document.querySelectorAll<HTMLInputElement>('input')].find(
          (i) => i.value === 'Gala 1'
        )!;
        type(title, 'Gala 2');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(savedDocuments().at(-1)).toMatchObject({ title: 'Gala 2', associationId: 'a2' });
        expect(byTestId('form-association-pending')).not.toBeNull();

        byTestId<HTMLButtonElement>('publish-button')!.click();
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        expect(api.publishFormDraft).toHaveBeenCalledWith('f1', 2, false);
        expect(savedDocuments().every((d, i) => i === 0 || d.associationId === 'a2')).toBe(true);
      },
      MOUNT_BUDGET_MS
    );

    it(
      "of a draft reopened on a revision that moved it: the editor shows the revision's",
      async () => {
        api.status = 'draft';
        api.associationId = 'a1';
        api.revision = {
          revision: 4,
          document: {
            title: 'Gala',
            basePrice: 0,
            currency: 'eur',
            items: [],
            associationId: 'a2',
          },
          savedAt: null,
          saveId: null,
        };
        await open();
        await vi.waitFor(() =>
          expect(document.querySelector('#association-select')?.textContent).toContain('BDS')
        );
        expect(byTestId('form-association-pending')).not.toBeNull();
        expect(api.saveFormDraft).not.toHaveBeenCalled();
      },
      MOUNT_BUDGET_MS
    );

    it(
      "of a published form holding a revision that names another: the stored one, never the revision's",
      async () => {
        api.status = 'published';
        api.associationId = 'a1';
        api.revision = {
          revision: 4,
          document: {
            title: 'Gala',
            basePrice: 0,
            currency: 'eur',
            items: [],
            associationId: 'a2',
          },
          savedAt: null,
          saveId: null,
        };
        await open();
        expect(document.querySelector('#association-select')).toBeNull();
        expect(document.body.textContent).toContain('BDE');
        expect(document.body.textContent).not.toContain('BDS');
      },
      MOUNT_BUDGET_MS
    );

    it(
      'of a published form: read-only, said why, and never sent with an edit',
      async () => {
        api.status = 'published';
        api.associationId = 'a1';
        await open();
        expect(document.querySelector('#association-select')).toBeNull();
        expect(byTestId('form-association-locked')?.textContent?.trim()).toBe(
          m.form_association_locked_hint()
        );
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        type(titleInput(), 'Gala published');
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
        await settle();
        expect(savedDocuments().at(-1)).not.toHaveProperty('associationId');
      },
      MOUNT_BUDGET_MS
    );
  });
});
