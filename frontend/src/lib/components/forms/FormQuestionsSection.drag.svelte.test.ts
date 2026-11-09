// @vitest-environment happy-dom
/**
 * The owner's defect (2026-11-06): dragging inside a question title to select text dragged the whole
 * card. A press on a field must leave the card NOT draggable; a press on the card's inert parts
 * must leave it draggable, and the card is draggable again once the gesture ends.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FormQuestionsSection from './FormQuestionsSection.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const items = [
    { id: 'q1', type: 'TEXT', label: 'Prenom', required: false, options: [] },
  ] as any[];
  const c = mount(FormQuestionsSection, { target, props: { items, requiresPayment: false } });
  mounted.push(() => unmount(c));
  flushSync();
  // Questions start collapsed: the fields a drag must not start from exist once one is open.
  target.querySelector<HTMLButtonElement>('[data-row-button]')!.click();
  flushSync();
  return target;
}

const press = (el: Element) =>
  el.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
const release = () => window.dispatchEvent(new Event('pointerup'));

describe('question card drag', () => {
  it('is draggable, not from a field, and draggable again afterwards', () => {
    const root = render();
    const card = root.querySelector<HTMLElement>('[draggable]')!;
    expect(card.getAttribute('draggable')).toBe('true');

    const field = card.querySelector('input, textarea')!;
    expect(field).toBeTruthy();
    press(field);
    expect(card.getAttribute('draggable')).toBe('false');
    release();
    expect(card.getAttribute('draggable')).toBe('true');
  });

  it('a press whose release was swallowed does not disable the next press', () => {
    const root = render();
    const card = root.querySelector<HTMLElement>('[draggable]')!;
    press(card.querySelector('input, textarea')!);
    expect(card.getAttribute('draggable')).toBe('false');
    // No pointerup: a context menu ate it. The next press on the card chrome must still drag.
    press(card);
    expect(card.getAttribute('draggable')).toBe('true');
  });

  it('keeps the drag for a press on the card chrome', () => {
    const root = render();
    const card = root.querySelector<HTMLElement>('[draggable]')!;
    press(card);
    expect(card.getAttribute('draggable')).toBe('true');
  });
});
