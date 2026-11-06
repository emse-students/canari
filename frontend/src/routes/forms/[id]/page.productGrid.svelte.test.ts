// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const submission = vi.hoisted(() => ({ productGridPrices: {} as Record<string, unknown> }));
const form = vi.hoisted(() => ({ items: [] as unknown[] }));

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
}));

import Page from './+page.svelte';

/**
 * A FORM OF PRICED GRIDS ON THE MEMBER'S PAGE (WP-G2): the order is totalled across every grid in
 * the sticky bar, the category the server applied is said under the header, and a send with no
 * article is held on the grid's own card.
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

  it('holds a send with no article on the first grid, said on its card', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await render();
    bar().querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!.click();
    await settle();
    const card = document.getElementById('q-hoodie')!;
    expect(card.querySelector('[role="alert"]')?.textContent).toContain(
      m.form_view_error_order_empty({ label: 'Sweat' })
    );

    await add('Sweat Noir M');
    expect(card.querySelector('[role="alert"]')).toBeNull();
  });
});
