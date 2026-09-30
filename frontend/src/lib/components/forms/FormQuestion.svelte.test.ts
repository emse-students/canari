/**
 * A QUESTION CARD HANDS ITS ANSWER BACK - the one thing moving it out of the page could break.
 *
 * Inline, every input bound straight to `selections[item.id]`. Behind a component the binding goes
 * through a `$bindable` prop, and for a choice list and a matrix through `bind:group` on it: an
 * answer that stays in the card and never reaches the page would still render perfectly. So each
 * type is clicked here and the value the PARENT holds is what is asserted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FormItem } from '$lib/forms/api';
import FormQuestionHarness from './FormQuestionHarness.test.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(item: FormItem, value: unknown, extra: Record<string, unknown> = {}) {
  const state = { value };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(FormQuestionHarness, {
    target,
    props: { item, initial: value, onChange: (v: unknown) => (state.value = v), ...extra },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const choice = (type: string): FormItem => ({
  id: 'q',
  label: 'Menu',
  required: true,
  type,
  options: [
    { id: 'a', label: 'A', priceModifier: 0 },
    { id: 'b', label: 'B', priceModifier: 250 },
  ],
});

describe('FormQuestion', () => {
  it('hands a typed answer back to the page', () => {
    const { target, state } = render(
      { id: 'q', label: 'Nom', required: true, type: 'short_text' },
      ''
    );
    const input = target.querySelector('input')!;
    input.value = 'Ada';
    input.dispatchEvent(new Event('input'));
    flushSync();
    expect(state.value).toBe('Ada');
  });

  it('hands a single choice back', () => {
    const { target, state } = render(choice('single_choice'), '');
    target.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    flushSync();
    expect(state.value).toBe('b');
  });

  it('hands every ticked option of a multiple choice back', () => {
    const { target, state } = render(choice('multiple_choice'), []);
    for (const box of target.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))
      box.click();
    flushSync();
    expect(state.value).toEqual(['a', 'b']);
  });

  it('hands a matrix row back', () => {
    const item: FormItem = { ...choice('matrix_single'), rows: ['r1'] };
    const { target, state } = render(item, { r1: '' });
    target.querySelectorAll<HTMLInputElement>('input[type=radio]')[0].click();
    flushSync();
    expect(state.value).toEqual({ r1: 'a' });
  });

  it('shows the supplement the page says an option adds, and none the page withholds', () => {
    const { target } = render(choice('single_choice'), '');
    expect(target.textContent).toContain('2,50');
    const priced = render(choice('single_choice'), '', { optionModifier: () => 0 });
    expect(priced.target.textContent).not.toContain('2,50');
  });

  it('refuses a closed option', () => {
    const { target } = render(choice('single_choice'), '', {
      optionClosed: (opt: { id?: string }) => opt.id === 'b',
    });
    expect(target.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].disabled).toBe(true);
  });
});
