// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const submitPublicForm = vi.hoisted(() =>
  vi.fn((_formId: string, _body: { answers: Record<string, unknown> }) =>
    Promise.resolve({ submissionId: 's1' })
  )
);

/** What the next mount reads: the jacket's switch, and the question that shows it (none: shown). */
const fixture = vi.hoisted(() => ({
  hoodieRequired: true,
  jacketRequired: false,
  jacketShownBy: null as null | { questionId: string; optionIds: string[] },
}));

/** Whether the estate stores each priced grid's own switch (`/api/version`), per test. */
const gate = vi.hoisted(() => ({ on: true }));
vi.mock('$lib/forms/gridRequiredGate', () => ({ gridRequiredSwitchOn: () => gate.on }));

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
        ...(fixture.jacketShownBy
          ? [
              {
                id: 'want',
                label: 'Une veste ?',
                required: false,
                type: 'single_choice',
                options: [{ id: 'oui', label: 'Oui' }],
              },
            ]
          : []),
        {
          id: 'hoodie',
          label: 'Sweat',
          required: fixture.hoodieRequired,
          type: 'product_grid',
          productGrid: productGrid(['Noir', 'Vert'], ['M', 'L']),
        },
        {
          id: 'jacket',
          label: 'Veste',
          required: fixture.jacketRequired,
          type: 'product_grid',
          productGrid: productGrid(['Taille'], ['S', 'XL']),
          ...(fixture.jacketShownBy ? { showIf: { answer: fixture.jacketShownBy } } : {}),
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
 * A FORM OF PRICED GRIDS ON THE GUEST PAGE (`/f/:id`): each grid's own "Obligatoire" switch (owner,
 * 2026-11-13) - a required grid left empty is held on ITS card, an optional one is no fault, and no
 * rule spans the grids.
 */
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  submitPublicForm.mockClear();
  gate.on = true;
  fixture.hoodieRequired = true;
  fixture.jacketRequired = false;
  fixture.jacketShownBy = null;
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

const cardAlert = (id: string) =>
  document.getElementById(`q-${id}`)?.querySelector('[role="alert"]');

describe('a guest form of priced grids', () => {
  it('holds a REQUIRED grid left empty on its own card, said until a unit is added', async () => {
    await render();
    expect(document.getElementById('q-hoodie')!.querySelector('h2')!.textContent).toContain('*');
    expect(document.getElementById('q-jacket')!.querySelector('h2')!.textContent).not.toContain(
      '*'
    );
    send();
    await settle();
    expect(cardAlert('hoodie')!.textContent).toContain(
      m.form_view_error_grid_empty({ label: 'Sweat' })
    );
    expect(cardAlert('jacket')).toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(submitPublicForm).not.toHaveBeenCalled();

    await add('Sweat Noir M');
    expect(cardAlert('hoodie')).toBeNull();
  });

  it('an order in another grid does not rescue a required one', async () => {
    await render();
    await add('Veste XL');
    send();
    await settle();
    expect(cardAlert('hoodie')).not.toBeNull();
    expect(submitPublicForm).not.toHaveBeenCalled();
  });

  it('sends the required grid ordered, the optional one left untouched and out of the payload', async () => {
    await render();
    await add('Sweat Noir M');
    send();
    await settle();
    await vi.waitFor(() => expect(submitPublicForm).toHaveBeenCalledTimes(1));
    const [, body] = submitPublicForm.mock.calls[0];
    expect(body.answers).toEqual({ hoodie: { 'Noir:M': 1 } });
  });

  it('sends a form whose grids are all optional with no article at all', async () => {
    fixture.hoodieRequired = false;
    await render();
    send();
    await settle();
    await vi.waitFor(() => expect(submitPublicForm).toHaveBeenCalledTimes(1));
    expect(submitPublicForm.mock.calls[0][1].answers).toEqual({});
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('never demands a required grid hidden by an answer condition', async () => {
    fixture.hoodieRequired = false;
    fixture.jacketRequired = true;
    fixture.jacketShownBy = { questionId: 'want', optionIds: ['oui'] };
    await render();
    expect(document.getElementById('q-jacket')).toBeNull();
    send();
    await settle();
    await vi.waitFor(() => expect(submitPublicForm).toHaveBeenCalledTimes(1));
  });
});

/**
 * [LEGACY] An estate older than each grid's switch (`gridRequiredSwitchOn` false): it stores every
 * grid required and means nothing by it, and refuses an EMPTY ORDER across the grids. The page holds
 * that send itself, the form's sentence and no card's, and draws no asterisk on a grid.
 */
describe('a guest form of priced grids, before the switch', () => {
  beforeEach(() => {
    gate.on = false;
  });

  it("holds an empty order, the form's and no card's, until a unit is added in ANY grid", async () => {
    await render();
    expect(document.getElementById('q-hoodie')!.querySelector('h2')!.textContent).not.toContain(
      '*'
    );
    send();
    await settle();
    const alert = document.getElementById('form-order-missing');
    expect(alert!.textContent).toContain(m.form_view_error_order_empty());
    expect(cardAlert('hoodie')).toBeNull();
    expect(submitPublicForm).not.toHaveBeenCalled();

    // A unit in the grid that was NOT the required one is enough: the order is what is held.
    await add('Veste XL');
    expect(document.getElementById('form-order-missing')).toBeNull();
    send();
    await settle();
    await vi.waitFor(() => expect(submitPublicForm).toHaveBeenCalledTimes(1));
    expect(submitPublicForm.mock.calls[0][1].answers).toEqual({ jacket: { 'Taille:XL': 1 } });
  });

  it('holds the empty order of a form whose grids are all optional too', async () => {
    fixture.hoodieRequired = false;
    await render();
    send();
    await settle();
    expect(document.getElementById('form-order-missing')).not.toBeNull();
    expect(submitPublicForm).not.toHaveBeenCalled();
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
