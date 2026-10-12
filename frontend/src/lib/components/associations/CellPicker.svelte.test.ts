/**
 * THE PICKER SAYS A UNION THE THREE PRESETS CANNOT (an institution for ICM here and ISMIN there).
 * It is drawn from the same pure helpers as the `/admin/spaces` grid, so what it shows must follow
 * `toggleGroup`: a campus box ticks every formation of that campus, a formation box one pair, and a
 * half-ticked campus reads as partial.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CellPicker from './CellPicker.svelte';
import { campusCells, cellOf, type Cell } from '$lib/associations/audienceRules';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(cells: Set<Cell>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CellPicker, { target, props: { cells } });
  mounted.push(() => void unmount(app));
  flushSync();
}

const pressed = (selector: string) =>
  document.querySelector(selector)?.getAttribute('aria-pressed') ?? null;

describe('CellPicker', () => {
  it('shows the pairs it is given, and a campus with only some of them as not fully ticked', () => {
    render(new Set([cellOf('ICM', 'gardanne')]));
    expect(pressed(`[data-cell="${cellOf('ICM', 'gardanne')}"]`)).toBe('true');
    expect(pressed(`[data-cell="${cellOf('ISMIN', 'gardanne')}"]`)).toBe('false');
    expect(pressed('[data-cell-campus="gardanne"]')).toBe('false');
    expect(pressed('[data-cell-campus="saint-etienne"]')).toBe('false');
  });

  it('a campus box ticks every formation of that campus and no other', () => {
    render(new Set());
    document.querySelector<HTMLButtonElement>('[data-cell-campus="saint-etienne"]')!.click();
    flushSync();
    expect(pressed('[data-cell-campus="saint-etienne"]')).toBe('true');
    for (const cell of campusCells('saint-etienne')) {
      expect(pressed(`[data-cell="${cell}"]`)).toBe('true');
    }
    for (const cell of campusCells('gardanne')) {
      expect(pressed(`[data-cell="${cell}"]`)).toBe('false');
    }
  });

  it('a formation box toggles one pair, so two campuses can be reached by one formation each', () => {
    render(new Set());
    document
      .querySelector<HTMLButtonElement>(`[data-cell="${cellOf('ICM', 'gardanne')}"]`)!
      .click();
    document
      .querySelector<HTMLButtonElement>(`[data-cell="${cellOf('ISMIN', 'saint-etienne')}"]`)!
      .click();
    flushSync();
    expect(pressed(`[data-cell="${cellOf('ICM', 'gardanne')}"]`)).toBe('true');
    expect(pressed(`[data-cell="${cellOf('ISMIN', 'saint-etienne')}"]`)).toBe('true');
    expect(pressed(`[data-cell="${cellOf('ICM', 'saint-etienne')}"]`)).toBe('false');
  });
});
