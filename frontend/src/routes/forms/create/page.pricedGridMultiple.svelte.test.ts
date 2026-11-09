// @vitest-environment happy-dom
/**
 * "PLUSIEURS REPONSES" GOES BACK OFF WITH THE GRID THAT TURNED IT ON - AND ONLY THEN.
 *
 * Adding a priced grid switches "several answers" on (a second order is a second answer). Removing
 * the grid, or turning it into another type, used to leave it on: a manager who tried a grid and
 * changed their mind kept a setting they never chose. The page now remembers that the EDITOR
 * switched it on, and a choice the manager makes on the switch is theirs to keep.
 */
import { afterEach, describe, expect, it, vi, afterAll } from 'vitest';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const route = vi.hoisted(() => ({
  page: { params: {}, url: new URL('https://canari.test/forms/create'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}), beforeNavigate: vi.fn() }));
const api = vi.hoisted(() => ({
  createForm: vi.fn(async (_payload: any) => ({ id: 'f-new' })),
  saveFormDraft: vi.fn(async (_id: string, base: number, _doc: any) => ({
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
/** The payload the builder last saved: what "Publier" publishes (`saveFormDraft`). */
const lastSaved = () => api.saveFormDraft.mock.calls.at(-1)![2];
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

/** Lets a grid the page's own check would refuse reach the (mocked) server, whose refusal is tested. */
const localCheck = vi.hoisted(() => ({ skip: false }));
vi.mock('$lib/forms/productGridEditor', async (orig) => {
  const real = await orig<typeof import('$lib/forms/productGridEditor')>();
  return {
    ...real,
    firstProductGridProblem: (...args: Parameters<typeof real.firstProductGridProblem>) =>
      localCheck.skip ? null : real.firstProductGridProblem(...args),
  };
});

import { SocialApiError } from '$lib/associations/api';
const caps = vi.hoisted(() => ({ formDrafts: true as boolean | null }));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverFormDrafts: () => caps.formDrafts,
}));

import Page from './+page.svelte';

/** Mounting the whole builder costs about 5 s on a cold suite (see page.returnNoRoute). */
const MOUNT_BUDGET_MS = 30_000;

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  api.createForm.mockClear();
  api.saveFormDraft.mockClear();
  api.publishFormDraft.mockClear();
  localCheck.skip = false;
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const byText = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
const byAria = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label)!;

async function open() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => void unmount(app));
  await settle();
  const title = document.querySelector<HTMLInputElement>(
    `input[placeholder="${m.form_title_placeholder()}"]`
  )!;
  title.value = 'Merch';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

async function addGrid() {
  buttons()
    .find((b) => b.textContent?.includes(m.form_add_question_button()))!
    .click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-menu-item="product_grid"]')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid="wizard-add"]')!.click();
  await settle();
}

/** Removes the open question through its "..." menu. */
async function removeOpenQuestion() {
  byAria(m.form_card_menu_aria()).click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-menu-item="remove"]')!.click();
  await settle();
}

/** The "several answers" switch, in the folded advanced section. */
async function multipleSwitch(): Promise<HTMLInputElement> {
  const header = buttons().find((b) => b.textContent?.includes(m.form_section_advanced()))!;
  if (header.getAttribute('aria-expanded') === 'false') header.click();
  await settle();
  const label = [...document.querySelectorAll('label')].find((l) =>
    l.textContent?.includes(m.form_allow_multiple_label())
  )!;
  return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

async function savedAllowMultiple(): Promise<boolean> {
  byText(m.form_publish_button()).click();
  await vi.waitFor(() => expect(api.publishFormDraft).toHaveBeenCalledTimes(1));
  // Created once, as a shell; everything else is the saved revision.
  expect(api.createForm).toHaveBeenCalledTimes(1);
  return lastSaved().allowMultipleSubmissions;
}

describe('the form builder, "several answers" and a priced grid', () => {
  it(
    'switches it back off when the grid that turned it on is removed',
    async () => {
      await open();
      await addGrid();
      expect((await multipleSwitch()).checked).toBe(true);
      await removeOpenQuestion();
      expect((await multipleSwitch()).checked).toBe(false);
      expect(await savedAllowMultiple()).toBe(false);
    },
    MOUNT_BUDGET_MS
  );

  it(
    'switches it back off when the grid becomes another type',
    async () => {
      await open();
      await addGrid();
      buttons()
        .find((b) => b.getAttribute('aria-haspopup') === 'listbox')!
        .click();
      await settle();
      document.querySelector<HTMLButtonElement>('[data-menu-item="short_text"]')!.click();
      await settle();
      expect(await savedAllowMultiple()).toBe(false);
    },
    MOUNT_BUDGET_MS
  );

  it(
    "keeps the manager's own choice: on before the grid, on after it",
    async () => {
      await open();
      const toggle = await multipleSwitch();
      toggle.click();
      await settle();
      expect(toggle.checked).toBe(true);
      await addGrid();
      await removeOpenQuestion();
      expect(await savedAllowMultiple()).toBe(true);
    },
    MOUNT_BUDGET_MS
  );
});

describe('the form builder, a grid refused by the server alone', () => {
  it(
    'draws the refusal under its grid and opens its card, not only in the banner',
    async () => {
      localCheck.skip = true;
      // A cotisation tier the association does not sell: only the server can know it.
      api.publishFormDraft.mockImplementationOnce(async () => {
        throw new SocialApiError(
          'refused',
          'PRODUCT_GRID_TIER_INVALID',
          400,
          null,
          null,
          lastSaved().items.find((i: any) => i.type === 'product_grid').id
        );
      });
      await open();
      await addGrid();
      const title = document.querySelector<HTMLInputElement>(
        `input[aria-label="${m.form_builder_question_label()}"]`
      )!;
      title.value = 'Sweat';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
      // Folded, as a manager leaves it: the refusal must open it again.
      byAria(m.form_builder_collapse_aria()).click();
      await settle();
      expect(document.querySelector('[data-testid="product-grid-editor"]')).toBeNull();
      byText(m.form_publish_button()).click();
      await vi.waitFor(() => expect(api.publishFormDraft).toHaveBeenCalledTimes(1));
      await settle();
      const sentence = m.form_pgrid_problem_in_question({
        label: 'Sweat',
        problem: m.form_pgrid_refusal_tier(),
      });
      expect(document.querySelector('[data-testid="grid-problem"]')?.textContent).toContain(
        sentence
      );
      expect(document.body.textContent).toContain(sentence);
    },
    MOUNT_BUDGET_MS
  );
});

afterAll(adoptTransitionAnimations());
