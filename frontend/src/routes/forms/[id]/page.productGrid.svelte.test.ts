// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const submission = vi.hoisted(() => ({ productGridPrices: {} as Record<string, unknown> }));
const form = vi.hoisted(() => ({ items: [] as unknown[] }));
const submitForm = vi.hoisted(() => vi.fn(() => Promise.resolve({ submissionId: 's1' })));

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'u1',
  getSavedDisplayName: () => 'Camille Martin',
}));
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
      title: 'Merch BDE',
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
      pricing: null,
      productGridPrices: submission.productGridPrices,
      hiddenItemIds: [],
      maySubmit: true,
    }),
  submitForm,
}));

import Page from './+page.svelte';

/**
 * A FORM OF PRICED GRIDS ON THE MEMBER'S PAGE (WP-G2): the order is totalled across every grid in
 * the sticky bar, the category the server applied is said under the header, and a send with no
 * article in ANY grid is held by one sentence for the form - an untouched grid is no fault.
 */
const productGrid = (rows: string[], cols: string[]) => ({
  rows: rows.map((r) => ({ id: r, label: r })),
  columns: cols.map((c) => ({ id: c, label: c })),
  maxPerCell: 5,
  closedCells: [],
  pricing: { mode: 'single' },
});

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  form.items = [
    {
      id: 'hoodie',
      label: 'Sweat',
      required: true,
      type: 'product_grid',
      productGrid: productGrid(['Noir', 'Vert'], ['M', 'L']),
    },
    {
      id: 'jacket',
      label: 'Veste',
      required: true,
      type: 'product_grid',
      productGrid: productGrid(['Taille'], ['S', 'XL']),
    },
  ];
  submission.productGridPrices = {
    hoodie: { tierId: 'cot', tierLabel: 'Cotisant BDE', prices: { '*': 2800 } },
    jacket: { tierId: 'cot', tierLabel: 'Cotisant BDE', prices: { '*': 3000 } },
  };
});
afterEach(() => {
  submitForm.mockClear();
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

const bar = () => document.querySelector<HTMLElement>('[data-order-bar]')!;
async function add(name: string) {
  const desktop = [...document.querySelectorAll<HTMLElement>('[data-grid-desktop]')];
  const button = desktop
    .map((root) =>
      root.querySelector<HTMLButtonElement>(
        `button[aria-label="${m.form_grid_add_cell({ name })}"]`
      )
    )
    .find(Boolean);
  if (!button) throw new Error(`no cell ${name}`);
  button.click();
  await settle();
}

describe('a form of priced grids', () => {
  it('totals the order across both grids, with a recap line per cell', async () => {
    await render();
    expect(bar().textContent).toContain(m.form_grid_order_total({ amount: '' }).trim());

    await add('Sweat Noir M');
    await add('Veste XL');
    expect(bar().textContent).toContain('58,00');
    expect(bar().textContent).toContain(m.form_grid_order_count({ count: 2 }));

    bar().querySelector<HTMLButtonElement>('[data-order-toggle]')!.click();
    await settle();
    const recap = bar().querySelector('[data-order-recap]')!.textContent ?? '';
    expect(recap).toContain('Sweat Noir M');
    // A one-row grid's line has no row label.
    expect(recap).toContain('Veste XL');
    expect(recap).not.toContain('Taille');
  });

  it('says who is answering and the category the server applied', async () => {
    await render();
    const line = document.querySelector('[data-viewer-tier]')?.textContent ?? '';
    expect(line).toContain('Camille Martin');
    expect(line).toContain(m.form_viewer_tier_prefix());
    expect(line.match(/Cotisant BDE/g)?.length).toBe(1);
  });

  it('holds a send with no article in ANY grid, said once for the form and on no card', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await render();
    // No grid draws an asterisk: none is required on its own.
    expect(document.getElementById('q-hoodie')!.querySelector('h2')!.textContent).not.toContain(
      '*'
    );
    const send = () =>
      bar().querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!.click();
    send();
    await settle();
    expect(document.body.textContent).toContain(m.form_view_error_order_empty());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(submitForm).not.toHaveBeenCalled();
  });

  it('sends an order from the second grid alone: the untouched first grid is no fault', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    // Free articles, so the send goes straight out (a paid one first asks the payer's address).
    submission.productGridPrices = {
      hoodie: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
      jacket: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
    };
    await render();
    await add('Veste XL');
    bar().querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!.click();
    await settle();
    expect(document.body.textContent).not.toContain(m.form_view_error_order_empty());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    // The send imports its checkout callbacks first: wait for the call rather than count ticks.
    await vi.waitFor(() => expect(submitForm).toHaveBeenCalledTimes(1));
    const [, body] = submitForm.mock.calls[0] as [string, { answers: Record<string, unknown> }];
    expect(body.answers).toEqual({ jacket: { 'Taille:XL': 1 } });
  });
});
