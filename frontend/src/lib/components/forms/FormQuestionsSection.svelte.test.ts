// @vitest-environment happy-dom
/**
 * THE COMPACT QUESTION EDITOR: one line per question, one card open at a time, the settings in one
 * icon row. Mounted through a parent that owns the bound list, as the admin pages do.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import Harness from './FormQuestionsSectionHarness.test.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const three = () => [
  { id: 'q1', type: 'short_text', label: 'First', required: true },
  { id: 'q2', type: 'single_choice', label: 'Second', options: [{ id: 'o1', label: 'x' }] },
  { id: 'q3', type: 'long_text', label: 'Third', showIf: {} },
];

function render(initial: any[] = three(), extra: Record<string, unknown> = {}) {
  const state = { items: initial as any[] };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Harness, {
    target,
    props: { initial, onItems: (i: any[]) => (state.items = i), ...extra },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const allButtons = (t: HTMLElement) => [...t.querySelectorAll<HTMLButtonElement>('button')];
/** The row button of question `n`: its accessible name is "Edit question n: title". */
const rowButton = (t: HTMLElement, n: number) =>
  allButtons(t).find((b) =>
    b.getAttribute('aria-label')?.startsWith(m.form_builder_open_question_aria({ n, title: '' }))
  )!;
const titleInputs = (t: HTMLElement) =>
  t.querySelectorAll<HTMLInputElement>(`input[aria-label="${m.form_builder_question_label()}"]`);
const byLabel = (t: HTMLElement, label: string) =>
  t.querySelector<HTMLButtonElement>(`[role="toolbar"] button[aria-label="${label}"]`)!;

describe('collapsed and expanded', () => {
  it('renders every question as one collapsed row, with an asterisk when required', () => {
    const { target } = render();
    expect(titleInputs(target).length).toBe(0);
    expect(target.querySelectorAll('[data-testid="required-mark"]').length).toBe(1);
    expect(target.textContent).toContain('First');
    expect(target.textContent).toContain('Third');
  });

  it('expands one card at a time and focuses its title', () => {
    const { target } = render();
    rowButton(target, 1).click();
    flushSync();
    expect(titleInputs(target).length).toBe(1);
    expect(document.activeElement).toBe(titleInputs(target)[0]);
    expect(titleInputs(target)[0].value).toBe('First');
    rowButton(target, 2).click();
    flushSync();
    expect(titleInputs(target).length).toBe(1);
    expect(titleInputs(target)[0].value).toBe('Second');
  });

  it('collapses on Escape and gives focus back to the row', () => {
    const { target } = render();
    rowButton(target, 1).click();
    flushSync();
    titleInputs(target)[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    flushSync();
    expect(titleInputs(target).length).toBe(0);
    expect(document.activeElement).toBe(rowButton(target, 1));
  });

  it('a new question is created expanded', () => {
    const { target, state } = render([]);
    allButtons(target)
      .find((b) => b.textContent?.includes(m.form_add_question_button()))!
      .click();
    flushSync();
    allButtons(target)
      .find((b) => b.textContent?.trim() === m.qtype_short_text())!
      .click();
    flushSync();
    expect(state.items.length).toBe(1);
    expect(titleInputs(target).length).toBe(1);
  });
});

describe('the settings row', () => {
  it('shows the audience panel only when conditions are switched on', () => {
    const { target } = render();
    rowButton(target, 1).click();
    flushSync();
    expect(target.querySelector('[data-testid="audience-panel"]')).toBeNull();
    byLabel(target, m.form_builder_conditions_aria()).click();
    flushSync();
    expect(target.querySelector('[data-testid="audience-panel"]')).not.toBeNull();
    byLabel(target, m.form_builder_conditions_aria()).click();
    flushSync();
    expect(target.querySelector('[data-testid="audience-panel"]')).toBeNull();
  });

  it('toggles required and deletes, every icon carrying an accessible name', () => {
    const { target, state } = render();
    rowButton(target, 2).click();
    flushSync();
    for (const btn of target.querySelectorAll('[role="toolbar"] button')) {
      expect(btn.getAttribute('aria-label')).toBeTruthy();
    }
    byLabel(target, m.form_builder_required_label()).click();
    flushSync();
    expect(state.items[1].required).toBe(true);
    byLabel(target, m.form_builder_delete_aria()).click();
    flushSync();
    expect(state.items.map((i) => i.id)).toEqual(['q1', 'q3']);
  });
});

describe('reveal', () => {
  it('opens the question a refused save names', () => {
    const { target } = render(three(), { reveal: { id: 'q3' } });
    expect(titleInputs(target).length).toBe(1);
    expect(titleInputs(target)[0].value).toBe('Third');
    expect(target.querySelector('[data-testid="audience-panel"]')).not.toBeNull();
  });
});

describe('duplicate', () => {
  it('copies from the collapsed row after the original, expanded with the title selected', () => {
    const { target, state } = render();
    target
      .querySelectorAll<HTMLButtonElement>(
        `button[aria-label="${m.form_builder_duplicate_aria()}"]`
      )[1]
      .click();
    flushSync();
    expect(state.items.map((i) => i.label)).toEqual(['First', 'Second', 'Second', 'Third']);
    expect(state.items[2].id).not.toBe('q2');
    expect(state.items[2].options[0].id).not.toBe('o1');
    const input = titleInputs(target)[0];
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('Ctrl+D duplicates and cancels the browser shortcut', () => {
    const { target, state } = render();
    const ev = new KeyboardEvent('keydown', {
      key: 'd',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    rowButton(target, 1).dispatchEvent(ev);
    flushSync();
    expect(ev.defaultPrevented).toBe(true);
    expect(state.items.length).toBe(4);
  });
});

describe('shortcuts and focus', () => {
  const key = (init: KeyboardEventInit) =>
    new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true, ...init });

  it('Ctrl+D ignores Meta (macOS owns that one), Shift, Alt and auto-repeat', () => {
    const { target, state } = render();
    const row = rowButton(target, 1);
    row.dispatchEvent(key({ metaKey: true }));
    row.dispatchEvent(key({ ctrlKey: true, shiftKey: true }));
    row.dispatchEvent(key({ ctrlKey: true, altKey: true }));
    flushSync();
    expect(state.items.length).toBe(3);
    const repeat = key({ ctrlKey: true, repeat: true });
    row.dispatchEvent(repeat);
    flushSync();
    // Cancelled so the browser does not bookmark, but nothing is copied.
    expect(repeat.defaultPrevented).toBe(true);
    expect(state.items.length).toBe(3);
  });

  it('deleting moves focus to the next row, else the previous, else the add button', async () => {
    const { target } = render();
    rowButton(target, 2).click();
    flushSync();
    byLabel(target, m.form_builder_delete_aria()).click();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(rowButton(target, 2));
    expect(document.activeElement?.getAttribute('aria-label')).toContain('Third');

    rowButton(target, 2).click();
    flushSync();
    byLabel(target, m.form_builder_delete_aria()).click();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(rowButton(target, 1));

    rowButton(target, 1).click();
    flushSync();
    byLabel(target, m.form_builder_delete_aria()).click();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement?.textContent).toContain(m.form_add_question_button());
  });
});

describe('what an open card shows', () => {
  it('a FILE question says, visibly, who reads the file', () => {
    const { target } = render();
    target.querySelectorAll<HTMLButtonElement>('[data-row-button]')[0].click();
    flushSync();
    expect(target.textContent).not.toContain(m.form_builder_file_hint());
    const file = render([{ id: 'f', type: 'file', label: 'CV' }]);
    file.target.querySelector<HTMLButtonElement>('[data-row-button]')!.click();
    flushSync();
    expect(file.target.textContent).toContain(m.form_builder_file_hint());
  });

  it('a duplicated row or column of a grid is marked when the card is revealed', () => {
    const grid = {
      id: 'g',
      type: 'matrix_single',
      label: 'Grille',
      rows: [
        { id: 'r1', value: 'R' },
        { id: 'r2', value: 'R' },
      ],
      options: [{ id: 'c1', label: 'A' }],
    };
    const { target } = render([grid], { reveal: { id: 'g' } });
    expect(target.textContent).toContain(m.form_builder_grid_duplicate_inline());
  });

  it('a required grid offers "every row"; an optional one does not', () => {
    const grid = (required: boolean) => ({
      id: 'g',
      type: 'matrix_single',
      label: 'Grille',
      required,
      rows: [{ id: 'r1', value: 'R' }],
      options: [{ id: 'c1', label: 'A' }],
    });
    expect(render([grid(true)], { reveal: { id: 'g' } }).target.textContent).toContain(
      m.form_builder_require_every_row()
    );
    expect(render([grid(false)], { reveal: { id: 'g' } }).target.textContent).not.toContain(
      m.form_builder_require_every_row()
    );
  });
});

describe('touch and drag targets', () => {
  it('the grip of a collapsed row is a 44 px handle and a press on it keeps the card draggable', () => {
    const { target } = render();
    const grip = target.querySelector<HTMLElement>('[data-drag-handle]')!;
    expect(grip.className).toContain('min-h-11');
    expect(grip.className).toContain('w-11');
    const card = grip.closest<HTMLElement>('[draggable]')!;
    grip.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(card.getAttribute('draggable')).toBe('true');
    // ...while the row's own button, which edits, does not start a drag.
    rowButton(target, 1).dispatchEvent(
      new Event('pointerdown', { bubbles: true, cancelable: true })
    );
    expect(card.getAttribute('draggable')).toBe('false');
    window.dispatchEvent(new Event('pointerup'));
    expect(card.getAttribute('draggable')).toBe('true');
  });

  it('the collapsed row and its duplicate icon are at least 44 px', () => {
    const { target } = render();
    expect(rowButton(target, 1).className).toContain('min-h-11');
    const dup = target.querySelector<HTMLElement>(
      `button[aria-label="${m.form_builder_duplicate_aria()}"]`
    )!;
    expect(dup.className).toContain('min-h-11');
    expect(dup.className).toContain('min-w-11');
  });
});

describe('the type menus', () => {
  const openAddMenu = (target: HTMLElement) => {
    allButtons(target)
      .find((b) => b.textContent?.includes(m.form_add_question_button()))!
      .click();
    flushSync();
  };

  it('offer the priced grid in both menus of a form', () => {
    const { target } = render();
    openAddMenu(target);
    expect(target.textContent).toContain(m.qtype_product_grid());
    rowButton(target, 1).click();
    flushSync();
    allButtons(target)
      .find((b) => b.getAttribute('aria-haspopup') === 'listbox')!
      .click();
    flushSync();
    expect(target.textContent).toContain(m.qtype_product_grid());
  });

  it('leave the priced grid out of a builder that never takes payment (a booking space)', () => {
    const { target } = render(three(), { offerPricedGrid: false });
    openAddMenu(target);
    expect(target.textContent).toContain(m.qtype_short_text());
    expect(target.textContent).not.toContain(m.qtype_product_grid());
    rowButton(target, 1).click();
    flushSync();
    allButtons(target)
      .find((b) => b.getAttribute('aria-haspopup') === 'listbox')!
      .click();
    flushSync();
    expect(target.textContent).not.toContain(m.qtype_product_grid());
  });

  it('add a priced grid required, with its definition, opened, and tell the page', () => {
    let told = 0;
    const { target, state } = render(three(), { onPricedGridAdded: () => (told += 1) });
    openAddMenu(target);
    allButtons(target)
      .find((b) => b.textContent?.trim() === m.qtype_product_grid())!
      .click();
    flushSync();
    const added = state.items[3];
    expect(added.type).toBe('product_grid');
    expect(added.required).toBe(true);
    expect(added.productGrid.rows).toHaveLength(1);
    expect(added.productGrid.maxPerCell).toBe(5);
    expect(told).toBe(1);
    expect(target.querySelector('[data-testid="product-grid-editor"]')).not.toBeNull();
    // The asterisk is not a choice on a grid: it stays on and cannot be switched off.
    const required = byLabel(target, m.form_builder_required_label());
    expect(required.disabled).toBe(true);
    expect(required.getAttribute('aria-pressed')).toBe('true');
  });

  it('draw a refused save under the grid it is about', () => {
    const grid = {
      id: 'g',
      type: 'product_grid',
      label: 'Sweat',
      required: true,
      productGrid: {
        rows: [{ id: 'r1', label: 'Vert' }],
        columns: [{ id: 'c1', label: 'M' }],
        maxPerCell: 5,
        closedCells: [],
        pricing: { mode: 'single', tiers: null, prices: { _all: { '*': null } } },
      },
    };
    const { target } = render([grid], {
      reveal: { id: 'g' },
      gridFault: { itemId: 'g', message: 'Il manque un prix' },
    });
    expect(target.querySelector('[data-testid="grid-problem"]')?.textContent).toContain(
      'Il manque un prix'
    );
  });
});
