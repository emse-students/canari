// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const submission = vi.hoisted(() => ({ productGridPrices: {} as Record<string, unknown> }));
const form = vi.hoisted(() => ({ items: [] as unknown[] }));
const submitForm = vi.hoisted(() =>
  vi.fn((_formId: string, _body: { answers: Record<string, unknown> }) =>
    Promise.resolve({ submissionId: 's1' })
  )
);

/** Whether the estate stores each priced grid's own switch (`/api/version`), per test. */
const gate = vi.hoisted(() => ({ on: true }));
vi.mock('$lib/forms/gridRequiredGate', () => ({ gridRequiredSwitchOn: () => gate.on }));

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
 * the sticky bar, the category the server applied is said under the header, and each grid's own
 * "Obligatoire" switch (owner, 2026-11-13) holds a send on ITS card - an optional grid is no fault.
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
      required: false,
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
  gate.on = true;
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

  it('holds a REQUIRED grid left empty on its own card, and lets it go once it holds a unit', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await render();
    // The asterisk of the required grid only.
    expect(document.getElementById('q-hoodie')!.querySelector('h2')!.textContent).toContain('*');
    expect(document.getElementById('q-jacket')!.querySelector('h2')!.textContent).not.toContain(
      '*'
    );
    const send = () =>
      bar().querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!.click();
    // An order in the OTHER grid does not rescue it.
    await add('Veste XL');
    send();
    await settle();
    const alert = document.getElementById('q-hoodie')!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(m.form_view_error_grid_empty({ label: 'Sweat' }));
    expect(document.getElementById('q-jacket')!.querySelector('[role="alert"]')).toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(submitForm).not.toHaveBeenCalled();

    await add('Sweat Noir M');
    expect(document.getElementById('q-hoodie')!.querySelector('[role="alert"]')).toBeNull();
  });

  it('sends a form whose grids are all optional and untouched, with no article', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    form.items = (form.items as Record<string, unknown>[]).map((item) => ({
      ...item,
      required: false,
    }));
    await render();
    bar().querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await vi.waitFor(() => expect(submitForm).toHaveBeenCalledTimes(1));
    expect(submitForm.mock.calls[0][1].answers).toEqual({});
  });

  it('sends an order from the second grid alone when the first is optional', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    form.items = (form.items as Record<string, unknown>[]).map((item) => ({
      ...item,
      required: false,
    }));
    // Free articles, so the send goes straight out (a paid one first asks the payer's address).
    submission.productGridPrices = {
      hoodie: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
      jacket: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
    };
    await render();
    await add('Veste XL');
    bar().querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    // The send imports its checkout callbacks first: wait for the call rather than count ticks.
    await vi.waitFor(() => expect(submitForm).toHaveBeenCalledTimes(1));
    const [, body] = submitForm.mock.calls[0];
    expect(body.answers).toEqual({ jacket: { 'Taille:XL': 1 } });
  });
});

/**
 * [LEGACY] An estate older than each grid's switch (`gridRequiredSwitchOn` false): it stores every
 * grid required and means nothing by it, and refuses an EMPTY ORDER across the grids. The page holds
 * that send itself, the form's sentence and no card's, and draws no asterisk on a grid.
 */
describe('a form of priced grids, before the switch', () => {
  beforeEach(() => {
    gate.on = false;
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("holds an empty order, the form's and no card's, until a unit is added in ANY grid", async () => {
    submission.productGridPrices = {
      hoodie: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
      jacket: { tierId: '_all', tierLabel: null, prices: { '*': 0 } },
    };
    await render();
    expect(document.getElementById('q-hoodie')!.querySelector('h2')!.textContent).not.toContain(
      '*'
    );
    const send = () =>
      bar().querySelector<HTMLButtonElement>('button:not([data-order-toggle])')!.click();
    send();
    await settle();
    expect(document.getElementById('form-order-missing')!.textContent).toContain(
      m.form_view_error_order_empty()
    );
    expect(document.getElementById('q-hoodie')!.querySelector('[role="alert"]')).toBeNull();
    expect(submitForm).not.toHaveBeenCalled();

    // A unit in the grid that was NOT the required one is enough: the order is what is held.
    await add('Veste XL');
    expect(document.getElementById('form-order-missing')).toBeNull();
    send();
    await settle();
    await vi.waitFor(() => expect(submitForm).toHaveBeenCalledTimes(1));
    expect(submitForm.mock.calls[0][1].answers).toEqual({ jacket: { 'Taille:XL': 1 } });
  });
});
