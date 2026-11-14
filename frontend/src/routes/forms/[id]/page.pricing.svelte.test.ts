// @vitest-environment happy-dom
/**
 * A PRICED FORM SAYS NOTHING ABOUT ITS PRICE UNTIL ITS PRICED QUESTIONS ARE ANSWERED (Mi 9T,
 * v1.2.9-alpha.3: "Cotisation BDE 2026" said "Combinaison indisponible" before any answer).
 *
 * A required priced question left blank falls in the grid's "others" group, which is not this
 * person's price: whether that cell is priced or closed, the header, the footer and the button stay
 * neutral, and no option of ANOTHER priced question is closed, until the answers choose a cell.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { CursusSlice, PricingView } from '$lib/forms/api';

const submission = vi.hoisted(() => ({
  pricing: null as PricingView | null,
  /** Every cursus slice (D32); null serves the one `pricing` as the only slice. */
  slices: null as CursusSlice[] | null,
}));
const form = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/posts/useFormReminder.svelte', () => ({
  useFormReminder: () => ({ load: () => Promise.resolve(), active: false }),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  getCalendarEventLinkedToForm: () => Promise.resolve({ linkedEvent: null }),
  getAssociation: () => Promise.reject(new Error('unused')),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Cotisation BDE 2026',
      description: '',
      items: form.items,
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
    }),
  checkSubmission: () =>
    Promise.resolve({
      hasSubmitted: false,
      formFull: false,
      pricing: submission.slices?.[0]?.pricing ?? submission.pricing,
      cursusSlices: submission.slices ?? [{ pricing: submission.pricing, productGridPrices: {} }],
      hiddenItemIds: [],
      maySubmit: true,
    }),
}));

import Page from './+page.svelte';

const choice = (id: string, labels: string[]) => ({
  id,
  label: id,
  required: true,
  type: 'single_choice',
  options: labels.map((l) => ({ id: l, label: l, priceModifier: 0 })),
});

/** One dimension per question, one group per option, plus the "others" group. */
function grid(questions: Record<string, string[]>, cells: Record<string, number | null>) {
  return {
    baseCents: 0,
    appliedLabels: [],
    answerDimensions: Object.entries(questions).map(([questionId, values]) => ({
      id: `d-${questionId}`,
      questionId,
      buckets: values.map((v) => ({ id: v, label: v, values: [v] })),
    })),
    cells,
    ignoredModifierQuestionIds: Object.keys(questions),
  } satisfies PricingView;
}

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  submission.slices = null;
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await settle();
}

const text = () => document.body.textContent ?? '';
const radio = (value: string) =>
  document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
async function choose(value: string) {
  radio(value).click();
  await settle();
}

describe('the price of a form whose priced question is not answered yet', () => {
  it('a PRICED "others" cell is not shown as the price before the answer', async () => {
    form.items = [choice('formation', ['icm', 'ast'])];
    submission.pricing = grid(
      { formation: ['icm', 'ast'] },
      { icm: 3000, ast: 4000, _others: 9900 }
    );
    await render();

    expect(text()).not.toContain('99');
    expect(text()).not.toContain(m.form_view_total_to_pay());
    expect(text()).not.toContain(m.form_view_combination_closed_title());

    await choose('icm');
    expect(text()).toContain(m.form_view_total_to_pay());
    expect(text()).toContain('30,00');
  });

  it('a CLOSED "others" cell does not say "Combinaison indisponible" before the answer', async () => {
    form.items = [choice('formation', ['icm', 'ast'])];
    submission.pricing = grid(
      { formation: ['icm', 'ast'] },
      { icm: 3000, ast: null, _others: null }
    );
    await render();

    expect(text()).not.toContain(m.form_view_combination_closed_title());
    expect(radio('ast').disabled).toBe(true);

    await choose('icm');
    expect(text()).not.toContain(m.form_view_combination_closed_title());
    expect(text()).toContain('30,00');
  });

  it('states the price once, in the footer, with the pricing that applied (user, 2026-10-23)', async () => {
    form.items = [choice('formation', ['icm', 'ast'])];
    submission.pricing = {
      ...grid({ formation: ['icm', 'ast'] }, { icm: 3000, ast: 4000, _others: null }),
      appliedLabels: ['Cotisant'],
    };
    await render();
    await choose('icm');

    expect(text()).toContain(`${m.form_view_total_to_pay()} (Cotisant)`);
    expect(text().match(/30,00/g)?.length).toBe(2); // the total and the pay button, no header badge
  });

  it('closes no option of one priced question while ANOTHER is still blank', async () => {
    form.items = [choice('formation', ['icm', 'ast']), choice('promo', ['p1', 'p2'])];
    const cells: Record<string, number | null> = {};
    for (const f of ['icm', 'ast', '_others']) {
      for (const p of ['p1', 'p2', '_others']) cells[`${f}|${p}`] = 1000;
    }
    cells['icm|p2'] = null;
    cells['icm|_others'] = null;
    submission.pricing = grid({ formation: ['icm', 'ast'], promo: ['p1', 'p2'] }, cells);
    await render();

    // `icm` with a blank promo lands on `icm|_others`, closed - but the promo is not chosen yet.
    expect(radio('icm').disabled).toBe(false);

    await choose('p2');
    expect(radio('icm').disabled).toBe(true);
  });
});

/**
 * TWO CURSUS (D32): the page is handed one slice per cursus and shows the cheapest for the answers
 * given, with the server's rule - the two scenarios of the review of #3530, which the page got wrong
 * when it was handed ONE slice (the same cases are in `libs/contracts/cursus-pricing.cases.json`, asserted on both
 * sides).
 */
describe('the price of a person with two cursus', () => {
  const twoSlices = (icm: Record<string, number | null>, others: Record<string, number | null>) => [
    {
      pricing: { ...grid({ formule: ['repas', 'sans'] }, icm), appliedLabels: ['ICM'] },
      productGridPrices: {},
    },
    { pricing: grid({ formule: ['repas', 'sans'] }, others), productGridPrices: {} },
  ];

  it('keeps open, at its price, an answer only the SECOND cursus prices', async () => {
    form.items = [choice('formule', ['repas', 'sans'])];
    submission.slices = twoSlices(
      { repas: 500, sans: null, _others: null },
      { repas: 1500, sans: 1000, _others: null }
    );
    await render();

    expect(radio('sans').disabled).toBe(false);
    await choose('sans');
    expect(text()).not.toContain(m.form_view_combination_closed_title());
    expect(text()).toContain('10,00');
  });

  it('never shows a dearer total than the one charged', async () => {
    form.items = [choice('formule', ['repas', 'sans'])];
    submission.slices = twoSlices(
      { repas: 5000, sans: 500, _others: null },
      { repas: 2000, sans: 1000, _others: null }
    );
    await render();

    await choose('repas');
    expect(text()).toContain('20,00');
    expect(text()).not.toContain('50,00');
    // The winning slice's groups only: the second cursus applied none.
    expect(text()).not.toContain('(ICM)');

    await choose('sans');
    expect(text()).toContain(`${m.form_view_total_to_pay()} (ICM)`);
    expect(text()).toContain('5,00');
  });
});
