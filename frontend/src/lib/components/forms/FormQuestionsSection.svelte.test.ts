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
