// @vitest-environment happy-dom
/**
 * THE TWO SWITCHES OF A CHOICE QUESTION - a free comment, and an "Autre" option. The "Autre" switch
 * is not a flag of its own: it adds or removes ONE option marked `other`, so it always reflects
 * whether such an option exists (the manager may also delete it from the options list).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import ChoiceNotesEditor from './ChoiceNotesEditor.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(item: Record<string, any>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ChoiceNotesEditor, { target, props: { item } });
  mounted.push(() => unmount(component));
  flushSync();
  return target;
}

const toggle = (target: HTMLElement, label: string) =>
  [...target.querySelectorAll<HTMLLabelElement>('label')]
    .find((el) => el.textContent?.includes(label))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!;

describe('ChoiceNotesEditor', () => {
  it('adds one "Autre" option marked as such, and removes it again', () => {
    const item = $state({ id: 'q', options: [{ id: 'a', label: 'A', priceModifier: 0 }] }) as any;
    const target = render(item);
    toggle(target, m.form_builder_other_toggle()).click();
    flushSync();
    expect(item.options.map((o: any) => [o.label, o.other])).toEqual([
      ['A', undefined],
      [m.form_option_other_label(), true],
    ]);
    toggle(target, m.form_builder_other_toggle()).click();
    flushSync();
    expect(item.options).toHaveLength(1);
  });

  it('reads the switch from the options, so deleting the option turns it off', () => {
    const target = render({
      id: 'q',
      options: [{ id: 'o', label: 'Autre', priceModifier: 0, other: true }],
    });
    expect(toggle(target, m.form_builder_other_toggle()).checked).toBe(true);
  });

  it('switches the comment on and off', () => {
    const item = $state({ id: 'q', options: [] }) as any;
    const target = render(item);
    toggle(target, m.form_builder_comment_toggle()).click();
    flushSync();
    expect(item.allowComment).toBe(true);
    toggle(target, m.form_builder_comment_toggle()).click();
    flushSync();
    expect(item.allowComment).toBe(false);
  });
});
