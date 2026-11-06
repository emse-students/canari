// @vitest-environment happy-dom
/**
 * THE PRICE TABLE READS A STORED GRID AS ROWS BY COLUMNS, AND EVERY EDIT REACHES THE PARENT.
 *
 * The data shape did not change with the 2026-11-06 redesign, so what is asserted here is the
 * drawing and the round trip: a stored grid opens as a 2D table, an empty cell says "Gratuit", the
 * corner and the header bar write the grid the PARENT holds, a third criterion is refused, and a
 * public form's free guest cell is flagged.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { FormItem } from '$lib/forms/api';
import { OTHERS_BUCKET_ID as O, type PriceMatrix } from '$lib/pricing/priceMatrix';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import Harness from './PriceGridEditorHarness.test.svelte';

// The criterion menu opens in a `FloatingSurface`, whose transitions happy-dom cancels on unmount.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** Promotion (1A, 2A) down the side, Formation (ICM) across the top. */
function stored(): PriceMatrix {
  return {
    dimensions: [
      {
        id: 'p',
        kind: 'promo',
        buckets: [
          { id: 'a1', label: '1A', values: [2026] },
          { id: 'a2', label: '2A', values: [2025] },
        ],
      },
      { id: 'f', kind: 'formation', buckets: [{ id: 'icm', label: 'ICM', values: ['ICM'] }] },
    ],
    cells: {
      'a1|icm': 15,
      [`a1|${O}`]: 0,
      'a2|icm': 20,
      [`a2|${O}`]: 20,
      [`${O}|icm`]: null,
      [`${O}|${O}`]: null,
    },
  };
}

function render(initial: PriceMatrix, extra: Record<string, unknown> = {}) {
  const state: { matrix: PriceMatrix | null } = { matrix: null };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Harness, {
    target,
    props: { initial, onChange: (v: PriceMatrix | null) => (state.matrix = v), ...extra },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const table = (t: HTMLElement) => t.querySelector<HTMLElement>('[data-testid="price-table"]')!;
const cell = (t: HTMLElement, key: string) =>
  table(t).querySelector<HTMLElement>(`[data-testid="price-cell"][data-key="${key}"]`)!;

function click(el: Element) {
  (el as HTMLElement).click();
  flushSync();
}

function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
  return [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
}

function type(input: HTMLInputElement, value: string, event: 'input' | 'change') {
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
  flushSync();
}

describe('PriceGridEditor', () => {
  it('opens a stored grid as a table: groups of the first criterion down, the second across', () => {
    const { target } = render(stored());
    const head = [...table(target).querySelectorAll('thead th')].map((th) =>
      th.textContent?.trim()
    );
    expect(head).toEqual([
      `${m.form_criterion_promo()} \\ ${m.form_criterion_formation()}`,
      'ICM',
      m.form_criterion_others(),
    ]);
    const rows = table(target).querySelectorAll('[data-testid="price-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelectorAll('[data-testid="price-cell"]')).toHaveLength(2);
    expect(cell(target, 'a1|icm').querySelector('input')!.value).toBe('15');
  });

  it('says "Gratuit" for an empty cell, and leaves the box empty', () => {
    const { target } = render(stored());
    const free = cell(target, `a1|${O}`);
    expect(free.querySelector('input')!.value).toBe('');
    expect(free.querySelector('.price-free-chip')?.textContent).toBe(m.form_grid_free());
    expect(cell(target, 'a1|icm').querySelector('.price-free-chip')).toBeNull();
  });

  it('commits a typed price, a comma included, and an emptied box back to 0', () => {
    const { target, state } = render(stored());
    const input = cell(target, 'a1|icm').querySelector('input')!;
    type(input, '12,5', 'change');
    expect(state.matrix!.cells['a1|icm']).toBe(12.5);
    type(input, '', 'change');
    expect(state.matrix!.cells['a1|icm']).toBe(0);
  });

  it('closes a cell from its corner, draws it struck through, and reopens it at 0', () => {
    const { target, state } = render(stored());
    click(cell(target, 'a1|icm').querySelector('.price-corner')!);
    expect(state.matrix!.cells['a1|icm']).toBeNull();
    const closed = cell(target, 'a1|icm');
    expect(closed.querySelector('.price-cell-closed')?.textContent).toBe(
      m.form_grid_cell_unavailable()
    );
    expect(closed.querySelector('input')).toBeNull();
    click(closed.querySelector('.price-corner')!);
    expect(state.matrix!.cells['a1|icm']).toBe(0);
  });

  it('fills a selected row with one price, and closes a selected column', () => {
    const { target, state } = render(stored());
    click(table(target).querySelector('tbody th button')!);
    const bar = target.querySelector<HTMLElement>('[data-testid="selection-bar"]')!;
    expect(bar.textContent).toContain(m.form_grid_selected_row({ name: '1A' }));
    type(bar.querySelector('input')!, '30', 'input');
    click(buttonNamed(bar, m.form_grid_apply()));
    expect(state.matrix!.cells['a1|icm']).toBe(30);
    expect(state.matrix!.cells[`a1|${O}`]).toBe(30);
    expect(state.matrix!.cells['a2|icm']).toBe(20);

    click(table(target).querySelectorAll('thead th button')[0]);
    const columnBar = target.querySelector<HTMLElement>('[data-testid="selection-bar"]')!;
    click(buttonNamed(columnBar, m.form_grid_close_all()));
    expect(state.matrix!.cells['a1|icm']).toBeNull();
    expect(state.matrix!.cells['a2|icm']).toBeNull();
    expect(state.matrix!.cells[`a2|${O}`]).toBe(20);
  });

  it('hides the rows where nothing is available', () => {
    const { target } = render(stored());
    const rows = () => table(target).querySelectorAll('[data-testid="price-row"]').length;
    expect(rows()).toBe(3);
    const toggle = [...target.querySelectorAll('label')].find((l) =>
      l.textContent?.includes(m.form_grid_hide_unavailable())
    )!;
    click(toggle.querySelector('input')!);
    expect(rows()).toBe(2);
  });

  it('refuses a third criterion from the menu, saying why', () => {
    const items: FormItem[] = [
      {
        id: 'meal',
        label: 'Repas',
        required: false,
        type: 'single_choice',
        options: [{ id: 'o1', label: 'Oui', priceModifier: 0 }],
      },
    ];
    const { target, state } = render(stored(), { items });
    click(buttonNamed(target, m.form_grid_add_criterion()));
    const menu = document.querySelector<HTMLElement>('[data-testid="criterion-menu"]')!;
    expect(menu.textContent).toContain(m.form_grid_criterion_full());
    const promo = [...menu.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(m.form_criterion_promo())
    )!;
    expect(promo.getAttribute('aria-disabled')).toBe('true');
    expect(promo.textContent).toContain(m.form_grid_criterion_taken());
    click(promo);
    const answer = [...menu.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(m.form_criterion_answer())
    )!;
    expect(answer.textContent).toContain(m.form_grid_criterion_full());
    click(answer);
    expect(state.matrix!.dimensions).toHaveLength(2);
  });

  it('still opens and keeps a stored grid of three criteria', () => {
    const three = stored();
    three.dimensions.push({
      id: 'q',
      kind: 'answer',
      questionId: 'meal',
      buckets: [{ id: 'yes', label: 'Repas', values: ['o1'] }],
    });
    three.cells = Object.fromEntries(
      Object.entries(stored().cells).flatMap(([k, v]) => [
        [`${k}|yes`, v],
        [`${k}|${O}`, v],
      ])
    );
    const items: FormItem[] = [
      {
        id: 'meal',
        label: 'Repas',
        required: false,
        type: 'single_choice',
        options: [{ id: 'o1', label: 'Oui', priceModifier: 0 }],
      },
    ];
    const { target, state } = render(three, { items });
    expect(table(target).querySelectorAll('[data-testid="price-row"]')).toHaveLength(6);
    expect(state.matrix).toEqual(three);
  });

  it('flags the free guest cell of a public form, and only there', () => {
    const grid = stored();
    grid.cells[`${O}|${O}`] = 0;
    const { target } = render(grid, { isPublic: true });
    expect(cell(target, `${O}|${O}`).querySelector('[data-testid="guest-free"]')?.textContent).toBe(
      m.form_grid_guest_free()
    );
    expect(cell(target, `a1|${O}`).querySelector('[data-testid="guest-free"]')).toBeNull();
    expect(target.querySelector('[role="status"]')).not.toBeNull();
  });

  it('does not flag it on a form that is not public', () => {
    const grid = stored();
    grid.cells[`${O}|${O}`] = 0;
    const { target } = render(grid);
    expect(target.querySelector('[data-testid="guest-free"]')).toBeNull();
  });

  it('draws one card per row on a phone, with a labelled pill per price, edited in place', () => {
    const { target, state } = render(stored());
    const cards = target.querySelectorAll('[data-testid="price-card"]');
    expect(cards).toHaveLength(3);
    const pills = cards[0].querySelectorAll<HTMLElement>('[data-testid="price-pill"]');
    const texts = [...pills].map((p) => p.textContent?.replace(/\s+/g, ' ').trim());
    expect(texts[0]).toMatch(/^ICM 15/);
    expect(texts[1]).toBe(`${m.form_criterion_others()} ${m.form_grid_free()}`);
    expect(cards[2].querySelector('.price-cell-closed')).not.toBeNull();
    click(pills[1]);
    const editor = cards[0].querySelector<HTMLElement>('[data-testid="pill-editor"]')!;
    type(editor.querySelector('input')!, '7', 'change');
    expect(state.matrix!.cells[`a1|${O}`]).toBe(7);
  });
});
