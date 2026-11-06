// @vitest-environment happy-dom
/**
 * THE PRICED GRID EDITOR (WP-G3), driven as a manager would: the table is the editor, and what it
 * leaves behind is a grid the contract accepts.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { productGridItemRefusal } from '$lib/forms/productGridContract';
import {
  addAxisEntries,
  euroInputText,
  newProductGrid,
  productGridPayload,
  setPrice,
  type EditorProductGrid,
  type ProductGridTierDimension,
} from '$lib/forms/productGridEditor';
import Harness from './ProductGridEditorHarness.test.svelte';

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: confirmMock }));

const mounted: (() => void)[] = [];
beforeEach(() => confirmMock.mockClear());
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function sweat(): EditorProductGrid {
  const grid = newProductGrid();
  grid.rows = [];
  grid.columns = [];
  addAxisEntries(grid, 'rows', ['Vert', 'Noir']);
  addAxisEntries(grid, 'columns', ['S', 'M']);
  setPrice(grid, '_all', '*', 28);
  return grid;
}

function render(initial: EditorProductGrid = sweat(), extra: Record<string, unknown> = {}) {
  const state = { grid: initial };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Harness, {
    target,
    props: { initial, onGrid: (g: EditorProductGrid) => (state.grid = g), ...extra },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const buttons = (t: HTMLElement) => [...t.querySelectorAll<HTMLButtonElement>('button')];
const byAria = (t: HTMLElement, label: string) =>
  t.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const byText = (t: HTMLElement, text: string) =>
  buttons(t).find((b) => b.textContent?.trim() === text)!;
const inputOf = (t: HTMLElement, label: string) =>
  t.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const valid = (grid: EditorProductGrid) =>
  productGridItemRefusal(
    { required: true, productGrid: productGridPayload(grid) },
    { isPublic: false, requiresPayment: true }
  );

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

describe('rows and columns', () => {
  it('adds a column with "+", focused, and a row with "Ajouter une ligne"', async () => {
    const { target, state } = render();
    byAria(target, m.form_pgrid_add_column()).click();
    flushSync();
    await tick();
    expect(state.grid.columns).toHaveLength(3);
    expect(document.activeElement).toBe(inputOf(target, m.form_pgrid_column_label({ n: 3 })));
    byText(target, m.form_pgrid_add_row()).click();
    flushSync();
    expect(state.grid.rows).toHaveLength(3);
  });

  it('renames a row and a column in place, their ids unchanged', () => {
    const { target, state } = render();
    const [rowId, colId] = [state.grid.rows[0].id, state.grid.columns[1].id];
    type(inputOf(target, m.form_pgrid_row_label({ n: 1 })), 'Vert sapin');
    type(inputOf(target, m.form_pgrid_column_label({ n: 2 })), 'XL');
    expect(state.grid.rows[0]).toEqual({ id: rowId, label: 'Vert sapin' });
    expect(state.grid.columns[1]).toEqual({ id: colId, label: 'XL' });
  });

  it('marks two rows of one name, as the save compares them', () => {
    const { target } = render();
    type(inputOf(target, m.form_pgrid_row_label({ n: 2 })), ' vert');
    expect(target.textContent).toContain(m.form_pgrid_refusal_duplicate_label());
  });

  it('removes a row and a column by their x', async () => {
    const { target, state } = render();
    byAria(target, m.form_pgrid_remove_row({ label: 'Noir' })).click();
    await tick();
    flushSync();
    byAria(target, m.form_pgrid_remove_column({ label: 'S' })).click();
    await tick();
    flushSync();
    expect(state.grid.rows.map((r) => r.label)).toEqual(['Vert']);
    expect(state.grid.columns.map((c) => c.label)).toEqual(['M']);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('warns before removing a row that has orders, and keeps it when the manager declines', async () => {
    const grid = sweat();
    const ordered = [`${grid.rows[1].id}:${grid.columns[0].id}`];
    const { target, state } = render(grid, { orderedCells: ordered });
    confirmMock.mockResolvedValueOnce(false);
    byAria(target, m.form_pgrid_remove_row({ label: 'Noir' })).click();
    await tick();
    flushSync();
    expect(confirmMock).toHaveBeenCalledWith(
      m.form_pgrid_remove_ordered_confirm(),
      expect.objectContaining({ danger: true })
    );
    expect(state.grid.rows).toHaveLength(2);
    byAria(target, m.form_pgrid_remove_row({ label: 'Noir' })).click();
    await tick();
    await tick();
    flushSync();
    expect(state.grid.rows).toHaveLength(1);
  });

  it('pastes a list as rows, replacing the blank row a new grid starts with', () => {
    const { target, state } = render(newProductGrid());
    byText(target, m.form_pgrid_paste_button()).click();
    flushSync();
    type(target.querySelector('textarea')!, 'Vert\nBordeaux, Noir');
    byText(target, m.form_pgrid_paste_as_rows()).click();
    flushSync();
    expect(state.grid.rows.map((r) => r.label)).toEqual(['Vert', 'Bordeaux', 'Noir']);
    expect(target.querySelector('textarea')).toBeNull();
  });

  it('pastes columns and names the ones already there', () => {
    const { target, state } = render();
    byText(target, m.form_pgrid_paste_button()).click();
    flushSync();
    type(target.querySelector('textarea')!, 'M, L, XL');
    byText(target, m.form_pgrid_paste_as_columns()).click();
    flushSync();
    expect(state.grid.columns.map((c) => c.label)).toEqual(['S', 'M', 'L', 'XL']);
    expect(target.textContent).toContain(m.form_pgrid_paste_duplicates({ labels: 'M' }));
  });

  it('moves a row with the arrow keys on its grip', async () => {
    const { target, state } = render();
    const grip = byAria(target, m.form_pgrid_move_row({ label: 'Vert' }));
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick();
    flushSync();
    expect(state.grid.rows.map((r) => r.label)).toEqual(['Noir', 'Vert']);
  });

  it('moves a column with the arrow keys on its grip', async () => {
    const { target, state } = render();
    const grip = byAria(target, m.form_pgrid_move_column({ label: 'M' }));
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await tick();
    flushSync();
    expect(state.grid.columns.map((c) => c.label)).toEqual(['M', 'S']);
  });
});

describe('cells', () => {
  it('closes a combination by clicking it, struck through, and reopens it', () => {
    const { target, state } = render();
    const key = `${state.grid.rows[1].id}:${state.grid.columns[0].id}`;
    const cell = () => target.querySelector<HTMLButtonElement>(`[data-cell="${key}"]`)!;
    cell().click();
    flushSync();
    expect(state.grid.closedCells).toEqual([key]);
    expect(cell().getAttribute('aria-pressed')).toBe('true');
    expect(cell().textContent).toContain(m.form_pgrid_cell_closed());
    expect(cell().className).toContain('line-through');
    cell().click();
    flushSync();
    expect(state.grid.closedCells).toEqual([]);
  });
});

describe('prices', () => {
  it('one price: a single field, read in euros with a comma', () => {
    const { target, state } = render();
    type(target.querySelector<HTMLInputElement>('[data-testid="price-single"]')!, '29,50');
    expect(state.grid.pricing.prices._all['*']).toBe(29.5);
    expect(valid(state.grid)).toBeNull();
  });

  it('shows what it STORED: an unreadable price clears, a third decimal reads rounded', () => {
    const { target, state } = render();
    const field = target.querySelector<HTMLInputElement>('[data-testid="price-single"]')!;
    type(field, '1e3');
    expect(state.grid.pricing.prices._all['*']).toBeNull();
    expect(field.value).toBe('');
    type(field, '19,999');
    expect(state.grid.pricing.prices._all['*']).toBe(20);
    expect(field.value).toBe(euroInputText(20));
  });

  it('per row: a price beside each row, seeded from the single price', () => {
    const { target, state } = render();
    byText(target, m.form_pgrid_mode_per_row()).click();
    flushSync();
    expect(state.grid.pricing.mode).toBe('per_row');
    const noir = inputOf(target, m.form_pgrid_price_row({ label: 'Noir' }));
    expect(noir.value).toBe('28');
    type(noir, '31');
    expect(productGridPayload(state.grid).pricing.prices._all[state.grid.rows[1].id]).toBe(3100);
    expect(valid(state.grid)).toBeNull();
  });

  it('per column: a price under each column header', () => {
    const { target, state } = render();
    byText(target, m.form_pgrid_mode_per_column()).click();
    flushSync();
    type(inputOf(target, m.form_pgrid_price_column({ label: 'M' })), '30');
    expect(state.grid.pricing.prices._all[state.grid.columns[1].id]).toBe(30);
    expect(target.querySelector('[data-testid="price-single"]')).toBeNull();
  });

  it('the cap per cell: a stepper, and at 1 the buyer gets a checkbox', () => {
    const { target, state } = render();
    for (let i = 0; i < 4; i++) {
      byAria(target, m.form_pgrid_max_decrease()).click();
      flushSync();
    }
    expect(state.grid.maxPerCell).toBe(1);
    expect(byAria(target, m.form_pgrid_max_decrease()).disabled).toBe(true);
    expect(target.textContent).toContain(m.form_pgrid_max_hint_checkbox());
  });
});

describe('categories', () => {
  const cotisants: ProductGridTierDimension = {
    id: 'd1',
    kind: 'cotisation',
    buckets: [{ id: 'b1', label: 'Cotisant BDE', anyTier: true }],
  };

  it('copies the registration price grid categories: one tab each, "Autres" last', () => {
    const { target, state } = render(sweat(), { formTiers: cotisants });
    target.querySelector<HTMLInputElement>('[role="switch"], input[type="checkbox"]')!.click();
    flushSync();
    const tabs = [...target.querySelectorAll('[data-tier-tab]')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Cotisant BDE', m.form_pgrid_tier_others()]);
    // Each tab is its own complete list: "Autres" priced apart.
    byText(target, m.form_pgrid_tier_others()).click();
    flushSync();
    type(target.querySelector<HTMLInputElement>('[data-testid="price-single"]')!, '31');
    expect(productGridPayload(state.grid).pricing.prices).toEqual({
      b1: { '*': 2800 },
      _others: { '*': 3100 },
    });
    expect(valid(state.grid)).toBeNull();
  });

  it('says a guest pays "Autres" on a public form', () => {
    const { target } = render(sweat(), { formTiers: cotisants, isPublic: true });
    target.querySelector<HTMLInputElement>('[role="switch"], input[type="checkbox"]')!.click();
    flushSync();
    expect(target.textContent).toContain(m.form_pgrid_tiers_hint_public());
  });
});

describe('the preview', () => {
  it('draws the desktop table, then the phone cards, closed cells struck through', () => {
    const grid = sweat();
    grid.closedCells = [`${grid.rows[1].id}:${grid.columns[0].id}`];
    const { target } = render(grid);
    expect(target.querySelector('[data-testid="grid-preview-desktop"]')).not.toBeNull();
    byText(target, m.form_pgrid_preview_phone()).click();
    flushSync();
    // The fill page's own component draws both; the preview forces the phone one and hides the other.
    const preview = target.querySelector('[data-testid="grid-preview-phone"]')!;
    expect(preview.querySelector('[data-grid-desktop]')!.classList).toContain('hidden');
    const phone = preview.querySelector('[data-grid-phone]')!;
    expect(phone.textContent).toContain('Noir');
    expect(phone.querySelectorAll('.line-through')).toHaveLength(1);
  });
});
