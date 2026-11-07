// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const submitPublicForm = vi.hoisted(() =>
  vi.fn((_formId: string, _body: { answers: Record<string, unknown> }) =>
    Promise.resolve({ submissionId: 's1' })
  )
);

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/f/f1'), state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => null }));

const productGrid = (rows: string[], cols: string[]) => ({
  rows: rows.map((r) => ({ id: r, label: r })),
  columns: cols.map((c) => ({ id: c, label: c })),
  maxPerCell: 5,
  closedCells: [],
  pricing: { mode: 'single' },
});

vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getPublicForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Merch BDE',
      description: '',
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: true,
      pricing: null,
      items: [
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
      ],
      // Free articles, so a send goes straight out (a paid one first asks the payer's address).
      productGridPrices: {
        hoodie: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
        jacket: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
      },
    }),
  submitPublicForm,
}));

import Page from './+page.svelte';

/**
 * A FORM OF PRICED GRIDS ON THE GUEST PAGE (`/f/:id`): the order is the form's - an untouched grid
 * is no fault, an empty order is said once, announced, and goes once a unit is added.
 */
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  submitPublicForm.mockClear();
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

const send = () =>
  document
    .querySelector<HTMLElement>('[data-order-bar]')!
    .querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!
    .click();

async function add(name: string) {
  const button = [...document.querySelectorAll<HTMLElement>('[data-grid-desktop]')]
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

describe('a guest form of priced grids', () => {
  it('holds an empty order with one announced sentence, gone once a unit is added', async () => {
    await render();
    send();
    await settle();
    const alert = document.getElementById('form-order-missing')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain(m.form_view_error_order_empty());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.getElementById('q-hoodie')!.querySelector('[role="alert"]')).toBeNull();
    expect(submitPublicForm).not.toHaveBeenCalled();

    await add('Sweat Noir M');
    expect(document.getElementById('form-order-missing')).toBeNull();
  });

  it('sends an order from the second grid alone: the untouched first grid is no fault', async () => {
    await render();
    await add('Veste XL');
    send();
    await settle();
    await vi.waitFor(() => expect(submitPublicForm).toHaveBeenCalledTimes(1));
    const [, body] = submitPublicForm.mock.calls[0];
    expect(body.answers).toEqual({ jacket: { 'Taille:XL': 1 } });
    expect(document.getElementById('form-order-missing')).toBeNull();
  });
});

describe('the guest order bar rests on the bottom of the screen', () => {
  it('sticks to bottom 0 with the home-indicator clearance, inside nothing that pads it', async () => {
    await render();
    const wrap = document.querySelector<HTMLElement>('[data-order-bar-wrap]')!;
    expect(wrap.classList.contains('sticky')).toBe(true);
    expect(wrap.classList.contains('bottom-0')).toBe(true);
    expect(wrap.className).toContain('pb-[max(0.75rem,var(--safe-area-inset-bottom,0px))]');
    expect(wrap.querySelector('[data-order-bar]')).not.toBeNull();
  });
});
