// @vitest-environment happy-dom
/**
 * SHARED COLUMNS IN THE GRID EDITOR (owner, 2026-11-21): the sizes are typed once and every grid of
 * the form that uses them follows. Driven as a manager would, through the real editor.
 */
import { describe, it, expect, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { ColumnSetQuestion } from '$lib/forms/productGridColumnSets';
import {
  addAxisEntries,
  firstProductGridProblem,
  newProductGrid,
  setPrice,
  type EditorProductGrid,
} from '$lib/forms/productGridEditor';
import Harness from './ProductGridSharedColumnsHarness.test.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: confirmMock }));

const mounted: (() => void)[] = [];
beforeEach(() => confirmMock.mockReset().mockResolvedValue(true));
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function shopGrid(row: string): EditorProductGrid {
  const grid = newProductGrid();
  grid.rows = [];
  grid.columns = [];
  addAxisEntries(grid, 'rows', [row]);
  addAxisEntries(grid, 'columns', ['S', 'M', 'L']);
  setPrice(grid, '_all', '*', 28);
  return grid;
}
const question = (id: string, productGrid: EditorProductGrid): ColumnSetQuestion => ({
  id,
  type: 'product_grid',
  productGrid,
});

function render(items: ColumnSetQuestion[], ordered: Record<string, string[]> = {}) {
  const state = { items };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Harness, {
    target,
    props: { initial: items, ordered, onItems: (i: ColumnSetQuestion[]) => (state.items = i) },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}
const section = (t: HTMLElement, id: string) => t.querySelector<HTMLElement>(`[data-q="${id}"]`)!;
const hid = (root: HTMLElement, testid: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}
const columnLabels = (items: ColumnSetQuestion[], id: string) =>
  items.find((i) => i.id === id)!.productGrid!.columns.map((c) => c.label);
const paid = { isPublic: false, requiresPayment: true };

describe('the grid editor - shared columns', () => {
  it('sharing offers the grids that already hold the same sizes, and joins them on a yes', async () => {
    const { target, state } = render([
      question('a', shopGrid('Sweat')),
      question('b', shopGrid('Tote')),
      question('c', shopGrid('Mug')),
    ]);
    type(hid(section(target, 'a'), 'column-set-new-name') as HTMLInputElement, 'Tailles');
    (hid(section(target, 'a'), 'column-set-share') as HTMLButtonElement).click();
    await tick();
    flushSync();
    expect(confirmMock).toHaveBeenCalledWith(
      m.form_pgrid_colset_join_matching_confirm({ count: 2 }),
      expect.objectContaining({ cancelLabel: m.form_pgrid_colset_join_matching_only_this() })
    );
    const sets = state.items.map((i) => i.productGrid!.columnSet?.id);
    expect(new Set(sets).size).toBe(1);
    expect(sets[0]).toBeTruthy();
    expect(hid(section(target, 'b'), 'column-set-in-use')?.textContent).toContain('3');
    expect(
      firstProductGridProblem(state.items as never, paid),
      'the shared grids are valid as sent'
    ).toBeNull();
  });

  it('declining leaves the other grids on their own columns', async () => {
    confirmMock.mockResolvedValue(false);
    const { target, state } = render([
      question('a', shopGrid('Sweat')),
      question('b', shopGrid('Tote')),
    ]);
    type(hid(section(target, 'a'), 'column-set-new-name') as HTMLInputElement, 'Tailles');
    (hid(section(target, 'a'), 'column-set-share') as HTMLButtonElement).click();
    await tick();
    flushSync();
    expect(state.items[0].productGrid!.columnSet?.name).toBe('Tailles');
    expect(state.items[1].productGrid!.columnSet ?? null).toBeNull();
  });

  it('renaming a shared column in one grid renames it in every grid of the set', async () => {
    const { target, state } = render([
      question('a', shopGrid('Sweat')),
      question('b', shopGrid('Tote')),
    ]);
    type(hid(section(target, 'a'), 'column-set-new-name') as HTMLInputElement, 'Tailles');
    (hid(section(target, 'a'), 'column-set-share') as HTMLButtonElement).click();
    await tick();
    flushSync();
    const field = section(target, 'a').querySelector<HTMLInputElement>(
      `input[aria-label="${m.form_pgrid_column_label({ n: 1 })}"]`
    );
    expect(field, 'a column label field').not.toBeNull();
    type(field!, 'Petit');
    expect(columnLabels(state.items, 'a')[0]).toBe('Petit');
    expect(columnLabels(state.items, 'b')[0]).toBe('Petit');
    expect(firstProductGridProblem(state.items as never, paid)).toBeNull();
  });

  it('a grid with its own columns can use a set another grid made, from the list', async () => {
    const a = shopGrid('Sweat');
    const { target, state } = render([question('a', a), question('b', shopGrid('Tote'))]);
    type(hid(section(target, 'a'), 'column-set-new-name') as HTMLInputElement, 'Tailles');
    confirmMock.mockResolvedValue(false);
    (hid(section(target, 'a'), 'column-set-share') as HTMLButtonElement).click();
    await tick();
    flushSync();
    const use = hid(section(target, 'b'), 'column-set-use') as HTMLButtonElement;
    expect(use, 'the set is offered to the other grid').not.toBeNull();
    expect(use.textContent).toContain(
      m.form_pgrid_colset_use_option({ name: 'Tailles', count: 3 })
    );
    use.click();
    await tick();
    flushSync();
    expect(state.items[1].productGrid!.columnSet?.id).toBe(
      state.items[0].productGrid!.columnSet?.id
    );
    expect(columnLabels(state.items, 'b')).toEqual(['S', 'M', 'L']);
  });

  it('removing a shared column ordered on a SIBLING grid asks first, as an ordered column does', async () => {
    const a = shopGrid('Sweat');
    const b = shopGrid('Tote');
    // b's row was ordered in the column a is about to lose - by the id the set gives it.
    const ordered = { b: [`${b.rows[0].id}:${a.columns[0].id}`] };
    const { target, state } = render([question('a', a), question('b', b)], ordered);
    type(hid(section(target, 'a'), 'column-set-new-name') as HTMLInputElement, 'Tailles');
    confirmMock.mockResolvedValue(false);
    (hid(section(target, 'a'), 'column-set-share') as HTMLButtonElement).click();
    await tick();
    flushSync();
    const use = hid(section(target, 'b'), 'column-set-use') as HTMLButtonElement;
    use.click();
    await tick();
    flushSync();
    expect(state.items[1].productGrid!.columnSet?.id).toBe(
      state.items[0].productGrid!.columnSet?.id
    );
    confirmMock.mockReset().mockResolvedValue(true);
    const remove = section(target, 'a').querySelector<HTMLButtonElement>(
      `button[aria-label="${m.form_pgrid_remove_column({ label: 'S' })}"]`
    );
    expect(remove, 'the remove button of column S').not.toBeNull();
    remove!.click();
    await tick();
    flushSync();
    expect(confirmMock).toHaveBeenCalledWith(
      m.form_pgrid_remove_ordered_confirm(),
      expect.objectContaining({ danger: true })
    );
    expect(columnLabels(state.items, 'a')).toEqual(['M', 'L']);
    expect(columnLabels(state.items, 'b')).toEqual(['M', 'L']);
  });

  it('putting a grid with answers on a set asks first: its columns are replaced by new ids', async () => {
    const a = shopGrid('Sweat');
    const b = shopGrid('Tote');
    const ordered = { b: [`${b.rows[0].id}:${b.columns[0].id}`] };
    const { target, state } = render([question('a', a), question('b', b)], ordered);
    type(hid(section(target, 'a'), 'column-set-new-name') as HTMLInputElement, 'Tailles');
    confirmMock.mockResolvedValue(false);
    (hid(section(target, 'a'), 'column-set-share') as HTMLButtonElement).click();
    await tick();
    flushSync();
    // b has answers, so it was never offered to the join: nothing was asked, nothing changed.
    expect(state.items[1].productGrid!.columnSet ?? null).toBeNull();
    confirmMock.mockClear();
    const use = hid(section(target, 'b'), 'column-set-use') as HTMLButtonElement;
    use.click();
    await tick();
    flushSync();
    expect(confirmMock).toHaveBeenCalledWith(
      m.form_pgrid_colset_apply_ordered_confirm(),
      expect.objectContaining({ danger: true })
    );
    // Cancelled: b keeps its own columns.
    expect(state.items[1].productGrid!.columnSet ?? null).toBeNull();
  });

  it('a grid that stops sharing keeps its columns and leaves the set', async () => {
    const { target, state } = render([
      question('a', shopGrid('Sweat')),
      question('b', shopGrid('Tote')),
    ]);
    type(hid(section(target, 'a'), 'column-set-new-name') as HTMLInputElement, 'Tailles');
    (hid(section(target, 'a'), 'column-set-share') as HTMLButtonElement).click();
    await tick();
    flushSync();
    (hid(section(target, 'b'), 'column-set-leave') as HTMLButtonElement).click();
    flushSync();
    expect(state.items[1].productGrid!.columnSet ?? null).toBeNull();
    expect(columnLabels(state.items, 'b')).toEqual(['S', 'M', 'L']);
    expect(hid(section(target, 'b'), 'column-set-new-name')).not.toBeNull();
  });
});
