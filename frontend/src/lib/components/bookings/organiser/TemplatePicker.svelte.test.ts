// @vitest-environment happy-dom
/**
 * THE WEEK TEMPLATES AS CARDS: four cards each with a miniature week; the wizard passes the chosen
 * one and gets `aria-pressed` and a lit card, the editor passes none and gets neither.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TemplatePicker from './TemplatePicker.svelte';

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

function open(selected?: 'always' | 'weekdays' | 'event' | 'empty' | null) {
  const onPick = vi.fn();
  mounted.push(mount(TemplatePicker, { target: document.body, props: { selected, onPick } }));
  flushSync();
  const card = (key: string) =>
    document.querySelector<HTMLButtonElement>(`[data-template="${key}"]`)!;
  return { onPick, card };
}

describe('TemplatePicker', () => {
  it('draws four cards, each with seven mini days', () => {
    const { card } = open();
    for (const key of ['always', 'weekdays', 'event', 'empty']) {
      expect(card(key).querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(7);
    }
    // "Toujours ouvert" fills every day, "Vide" none.
    expect(card('always').querySelectorAll('.bg-cn-yellow')).toHaveLength(7);
    expect(card('empty').querySelectorAll('.bg-cn-yellow')).toHaveLength(0);
    expect(card('weekdays').querySelectorAll('.bg-cn-yellow')).toHaveLength(5);
  });

  it('marks only the selected card pressed when a selection is passed', () => {
    const { card } = open('weekdays');
    expect(card('weekdays').getAttribute('aria-pressed')).toBe('true');
    expect(card('always').getAttribute('aria-pressed')).toBe('false');
  });

  it('carries no pressed state where a template is an action', () => {
    const { card } = open();
    expect(card('always').hasAttribute('aria-pressed')).toBe(false);
  });

  it('reports the pressed card', () => {
    const { card, onPick } = open(null);
    card('event').click();
    expect(onPick).toHaveBeenCalledWith('event');
  });
});
