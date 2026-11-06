// @vitest-environment happy-dom
/**
 * A PRICED GRID HANDS ITS ORDER BACK (`product_grid`, WP-G2) - through a bound value, as the fill
 * pages mount it, and the value the PARENT holds is what is asserted.
 *
 * Both drawings are in the DOM (the width picks one by CSS alone), so each test drives the one it
 * names: `[data-grid-desktop]` (the table) or `[data-grid-phone]` (the cards and pills).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FormItem } from '$lib/forms/api';
import type { ProductGridView, ProductGridViewerPrices } from '$lib/forms/productGridContract';
import { m } from '$lib/paraglide/messages';
import ProductGridQuestionHarness from './ProductGridQuestionHarness.test.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const grid = (over: Partial<ProductGridView> = {}): ProductGridView => ({
  rows: [
    { id: 'noir', label: 'Noir' },
    { id: 'vert', label: 'Vert' },
  ],
  columns: [
    { id: 'm', label: 'M' },
    { id: 'l', label: 'L' },
  ],
  maxPerCell: 2,
  closedCells: ['vert:m'],
  pricing: { mode: 'single' },
  ...over,
});

const item = (productGrid: ProductGridView): FormItem => ({
  id: 'pg',
  label: 'Sweat',
  description: '300g - broderie',
  required: true,
  type: 'product_grid',
  productGrid,
});

const prices: ProductGridViewerPrices = { tierId: '_all', tierLabel: null, prices: { '*': 2800 } };

function render(productGrid: ProductGridView, value: unknown = {}, extra = {}) {
  const state = { value };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ProductGridQuestionHarness, {
    target,
    props: {
      item: item(productGrid),
      grid: productGrid,
      initial: value,
      onChange: (v: unknown) => (state.value = v),
      gridPrices: prices,
      ...extra,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const desktop = (target: HTMLElement) => target.querySelector<HTMLElement>('[data-grid-desktop]')!;
const phone = (target: HTMLElement) => target.querySelector<HTMLElement>('[data-grid-phone]')!;
function click(root: HTMLElement, label: string) {
  const button = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no button "${label}"`);
  button.click();
  flushSync();
}
const button = (root: HTMLElement, label: string) =>
  root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('ProductGridQuestion', () => {
  it('shows the product, its price and its spec line', () => {
    const { target } = render(grid());
    expect(target.querySelector('h2')?.textContent).toContain('Sweat');
    expect(target.querySelector('[data-grid-price]')?.textContent).toContain('28,00');
    expect(target.textContent).toContain('300g - broderie');
  });

  it('turns a "+" into a stepper bounded by maxPerCell, and back at 0', () => {
    const { target, state } = render(grid());
    const table = desktop(target);
    click(table, m.form_grid_add_cell({ name: 'Sweat Noir M' }));
    expect(state.value).toEqual({ 'noir:m': 1 });

    const plus = m.form_grid_add_one({ name: 'Sweat Noir M' });
    click(table, plus);
    expect(state.value).toEqual({ 'noir:m': 2 });
    // At the cap, + is disabled and a forced click changes nothing.
    expect(button(table, plus)!.disabled).toBe(true);
    click(table, plus);
    expect(state.value).toEqual({ 'noir:m': 2 });

    const minus = m.form_grid_remove_one({ name: 'Sweat Noir M' });
    click(table, minus);
    click(table, minus);
    expect(state.value).toEqual({});
    expect(button(table, m.form_grid_add_cell({ name: 'Sweat Noir M' }))).not.toBeNull();
  });

  it('draws a closed cell struck through, with nothing to click', () => {
    const { target } = render(grid());
    for (const root of [desktop(target), phone(target)]) {
      const closed = root.querySelector(
        '[aria-label="' + m.form_grid_cell_closed_aria({ name: 'Sweat Vert M' }) + '"]'
      );
      expect(closed?.className).toContain('line-through');
      expect(button(root, m.form_grid_add_cell({ name: 'Sweat Vert M' }))).toBeNull();
    }
  });

  it('draws a checkbox per cell at a cap of 1', () => {
    const { target, state } = render(grid({ maxPerCell: 1 }));
    const box = desktop(target).querySelector<HTMLInputElement>(
      'input[type="checkbox"][aria-label="Sweat Noir L"]'
    )!;
    box.click();
    flushSync();
    expect(state.value).toEqual({ 'noir:l': 1 });
    box.click();
    flushSync();
    expect(state.value).toEqual({});
  });

  it('on a phone, a tapped size pill becomes "M x1" with - and +', () => {
    const { target, state } = render(grid());
    const cards = phone(target);
    click(cards, m.form_grid_add_cell({ name: 'Sweat Noir M' }));
    expect(state.value).toEqual({ 'noir:m': 1 });
    expect(cards.textContent).toContain(m.form_grid_pill_quantity({ size: 'M', quantity: 1 }));

    click(cards, m.form_grid_add_one({ name: 'Sweat Noir M' }));
    click(cards, m.form_grid_add_cell({ name: 'Sweat Vert L' }));
    expect(state.value).toEqual({ 'noir:m': 2, 'vert:l': 1 });
  });

  it('gives a one-row grid no row label, and keys its answer by that row', () => {
    const { target, state } = render(
      grid({ rows: [{ id: 'taille', label: 'Taille' }], closedCells: [] })
    );
    expect(desktop(target).querySelector('th[scope="row"]')).toBeNull();
    expect(phone(target).textContent).not.toContain('Taille');
    click(desktop(target), m.form_grid_add_cell({ name: 'Sweat L' }));
    expect(state.value).toEqual({ 'taille:l': 1 });
  });

  it('writes the price on each row in per-row mode, under each size in per-column mode', () => {
    const perRow = render(
      grid({ pricing: { mode: 'per_row' } }),
      {},
      {
        gridPrices: { tierId: '_all', tierLabel: null, prices: { noir: 2800, vert: 3100 } },
      }
    );
    expect(desktop(perRow.target).querySelector('th[scope="row"]')?.textContent).toContain('28,00');
    expect(phone(perRow.target).textContent).toContain('31,00');
    // Rows differ, so the header says "from" the lowest.
    const header = perRow.target.querySelector('[data-grid-price]')?.textContent ?? '';
    expect(header).toContain(m.form_grid_price_from({ amount: '' }).trim());
    expect(header).toContain('28,00');

    const perColumn = render(
      grid({ pricing: { mode: 'per_column' } }),
      {},
      {
        gridPrices: { tierId: '_all', tierLabel: null, prices: { m: 2500, l: 2700 } },
      }
    );
    const heads = [...desktop(perColumn.target).querySelectorAll('th[scope="col"]')];
    expect(heads.map((h) => h.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('25,00'),
      expect.stringContaining('27,00'),
    ]);
  });

  it('says a refusal under the grid', () => {
    const { target } = render(grid(), {}, { error: 'Ajoutez au moins un article' });
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      'Ajoutez au moins un article'
    );
    expect(target.querySelector('[data-product-grid]')?.className).toContain('border-red-err');
  });

  it('keeps keyboard focus on the cell when a control is replaced at 0', async () => {
    // The "+" of an empty cell becomes a stepper, and a stepper at 1 goes back to a "+": the button
    // pressed leaves the DOM, so focus must follow to its replacement in the SAME drawing.
    const { target } = render(grid());
    const name = 'Sweat Noir M';
    for (const root of [desktop(target), phone(target)]) {
      const add = button(root, m.form_grid_add_cell({ name }))!;
      add.focus();
      add.click();
      flushSync();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(document.activeElement).toBe(button(root, m.form_grid_add_one({ name })));

      button(root, m.form_grid_remove_one({ name }))!.click();
      flushSync();
      await new Promise((r) => setTimeout(r, 0));
      expect(document.activeElement).toBe(button(root, m.form_grid_add_cell({ name })));
    }
  });
});
