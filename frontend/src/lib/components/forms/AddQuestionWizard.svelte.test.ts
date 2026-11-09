// @vitest-environment happy-dom
/**
 * ADDING A QUESTION IN TWO STEPS (owner, 2026-11-07): the type, grouped by family, then a short
 * sheet with only that type's essentials; "Ajouter" inserts the filled card where it was asked
 * for, "Annuler" and Escape insert nothing, the back arrow returns to the types. Mounted through
 * the section, as the admin pages mount it.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import Harness from './FormQuestionsSectionHarness.test.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(initial: any[] = []) {
  const state = { items: initial as any[] };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Harness, {
    target,
    props: { initial, onItems: (i: any[]) => (state.items = i) },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const wizard = () => document.querySelector<HTMLElement>('[data-testid="add-question-wizard"]');
const menuItem = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-menu-item="${key}"]`)!;
const addButton = (t: HTMLElement) =>
  [...t.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(m.form_add_question_button())
  )!;
const titleField = () => document.querySelector<HTMLInputElement>('[data-wizard-title]')!;

function open(t: HTMLElement) {
  // A real click focuses the button; the dialog gives the focus back to it.
  addButton(t).focus();
  addButton(t).click();
  flushSync();
}

function choose(kind: string) {
  menuItem(kind).click();
  flushSync();
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function clickAdd() {
  document.querySelector<HTMLButtonElement>('[data-testid="wizard-add"]')!.click();
  flushSync();
}

describe('step 1: the types, grouped', () => {
  it('lists the families under small titles, in order, icon left and label left-aligned', async () => {
    const { target } = render();
    open(target);
    await tick();
    expect(wizard()?.dataset.step).toBe('type');
    const titles = [...document.querySelectorAll('[data-menu-section-title]')].map((p) =>
      p.textContent?.trim()
    );
    expect(titles).toEqual([
      m.qfamily_text(),
      m.qfamily_choice(),
      m.qfamily_grids(),
      m.qfamily_other(),
    ]);
    const keys = [...document.querySelectorAll<HTMLElement>('[data-menu-item]')].map(
      (b) => b.dataset.menuItem
    );
    expect(keys).toEqual([
      'short_text',
      'long_text',
      'single_choice',
      'multiple_choice',
      'dropdown',
      'linear_scale',
      'matrix',
      'product_grid',
      'file',
    ]);
    const item = menuItem('matrix');
    expect(item.className).toContain('text-left');
    expect(item.className).not.toContain('text-center');
    // The icon comes first, then the label and its one line.
    expect(item.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(item.textContent).toContain(m.qtype_matrix());
    expect(item.textContent).toContain(m.qtype_desc_matrix());
    // The first type holds the focus.
    expect(document.activeElement).toBe(menuItem('short_text'));
  });
});

describe('step 2: only the essentials of the type', () => {
  const cases: [string, string | null][] = [
    ['short_text', null],
    ['single_choice', 'choice-options-editor'],
    ['linear_scale', 'scale-editor'],
    ['matrix', 'matrix-grid-editor'],
    ['product_grid', 'product-grid-editor'],
    ['file', null],
  ];

  for (const [kind, editor] of cases) {
    it(`${kind}: the title${editor ? ` and ${editor}` : ', and "Obligatoire"'}`, async () => {
      const { target } = render();
      open(target);
      choose(kind);
      await tick();
      expect(wizard()?.dataset.step).toBe('details');
      expect(document.activeElement).toBe(titleField());
      for (const other of [
        'choice-options-editor',
        'scale-editor',
        'matrix-grid-editor',
        'product-grid-editor',
      ]) {
        expect(document.querySelector(`[data-testid="${other}"]`) !== null).toBe(other === editor);
      }
      const requiredSwitch = [...document.querySelectorAll('label')].some((l) =>
        l.textContent?.includes(m.form_add_wizard_required())
      );
      expect(requiredSwitch).toBe(editor === null);
      // Image, description and conditions stay in the card.
      expect(wizard()!.textContent).not.toContain(m.form_builder_add_desc());
      expect(wizard()!.textContent).not.toContain(m.form_show_if_toggle());
    });
  }

  it('a priced grid shows its prices but not the cap per cell nor the preview', () => {
    const { target } = render();
    open(target);
    choose('product_grid');
    expect(document.querySelector('[data-testid="max-per-cell"]')).toBeNull();
    expect(document.querySelector('[data-testid="grid-preview-desktop"]')).toBeNull();
    expect(document.querySelector('[data-testid="price-single"]')).not.toBeNull();
  });
});

describe('Ajouter, Annuler, Escape and back', () => {
  it('Ajouter inserts the filled question at the end, opened', () => {
    const { target, state } = render([{ id: 'q1', type: 'short_text', label: 'First' }]);
    open(target);
    choose('single_choice');
    type(titleField(), 'Menu');
    const option = document.querySelector<HTMLInputElement>(
      `[data-testid="choice-options-editor"] input[placeholder="${m.form_builder_option_placeholder()}"]`
    )!;
    type(option, 'Vegetarien');
    clickAdd();
    expect(wizard()).toBeNull();
    expect(state.items.map((i) => i.label)).toEqual(['First', 'Menu']);
    expect(state.items[1].type).toBe('single_choice');
    expect(state.items[1].options[0].label).toBe('Vegetarien');
    const titles = target.querySelectorAll<HTMLInputElement>(
      `input[aria-label="${m.form_builder_question_label()}"]`
    );
    expect(titles).toHaveLength(1);
    expect(titles[0].value).toBe('Menu');
  });

  it('a question asked for from a card goes right after that card', () => {
    const { target, state } = render([
      { id: 'q1', type: 'short_text', label: 'First' },
      { id: 'q2', type: 'short_text', label: 'Second' },
    ]);
    target.querySelector<HTMLButtonElement>('[data-row-button]')!.click();
    flushSync();
    target
      .querySelector<HTMLButtonElement>(`button[aria-label="${m.form_card_menu_aria()}"]`)!
      .click();
    flushSync();
    menuItem('insert_after').click();
    flushSync();
    choose('long_text');
    type(titleField(), 'Between');
    clickAdd();
    expect(state.items.map((i) => i.label)).toEqual(['First', 'Between', 'Second']);
  });

  it('Annuler inserts nothing', () => {
    const { target, state } = render([{ id: 'q1', type: 'short_text', label: 'First' }]);
    open(target);
    choose('short_text');
    type(titleField(), 'Never');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === m.common_cancel_button()
    )!;
    cancel.click();
    flushSync();
    expect(wizard()).toBeNull();
    expect(state.items.map((i) => i.label)).toEqual(['First']);
    expect(document.activeElement).toBe(addButton(target));
  });

  it('Escape closes the wizard and inserts nothing', () => {
    const { target, state } = render();
    open(target);
    choose('short_text');
    titleField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(wizard()).toBeNull();
    expect(state.items).toHaveLength(0);
  });

  it('the back arrow returns to the types, the type left holding the focus', async () => {
    const { target, state } = render();
    open(target);
    choose('linear_scale');
    document.querySelector<HTMLButtonElement>('[data-testid="wizard-back"]')!.click();
    flushSync();
    await tick();
    expect(wizard()?.dataset.step).toBe('type');
    expect(document.activeElement).toBe(menuItem('linear_scale'));
    expect(state.items).toHaveLength(0);
  });
});

describe('the "Grille de choix"', () => {
  it('is added single-answer, and its switch writes matrix_multiple', () => {
    const { target, state } = render();
    open(target);
    choose('matrix');
    const toggle = [...document.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(m.form_matrix_multiple_toggle()))!
      .querySelector<HTMLInputElement>('input')!;
    expect(toggle.checked).toBe(false);
    expect(document.querySelector('[data-matrix-cell="radio"]')).not.toBeNull();
    toggle.click();
    flushSync();
    expect(document.querySelector('[data-matrix-cell="checkbox"]')).not.toBeNull();
    clickAdd();
    expect(state.items[0].type).toBe('matrix_multiple');
  });

  it('an existing matrix_multiple shows the switch on, in the same table as the priced grid', () => {
    const { target, state } = render([
      {
        id: 'g',
        type: 'matrix_multiple',
        label: 'Dispos',
        rows: [{ id: 'r1', value: 'Lundi' }],
        options: [{ id: 'c1', label: 'Matin' }],
      },
    ]);
    target.querySelector<HTMLButtonElement>('[data-row-button]')!.click();
    flushSync();
    const toggle = [...target.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(m.form_matrix_multiple_toggle()))!
      .querySelector<HTMLInputElement>('input')!;
    expect(toggle.checked).toBe(true);
    expect(target.querySelector('[data-testid="grid-axes-table"]')).not.toBeNull();
    // The card names it "Grille de choix", not "Grille multiple".
    expect(target.textContent).not.toContain(m.qtype_matrix_multiple());
    toggle.click();
    flushSync();
    expect(state.items[0].type).toBe('matrix_single');
  });
});
