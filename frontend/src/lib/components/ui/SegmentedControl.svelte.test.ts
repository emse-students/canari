/**
 * THE FIXED TAB SET: every entry visible at once, full tablist semantics, keys that move and select.
 * Layout (nothing clipped at 320 px) is a browser reading; what is pinned here is the contract.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { Settings } from '@lucide/svelte';
import SegmentedControl from './SegmentedControl.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const ITEMS = [
  { key: 'a', label: 'Alpha', icon: Settings },
  { key: 'b', label: 'Beta', badge: 4 },
  { key: 'c', label: 'Gamma' },
];

function render(props: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(SegmentedControl, {
    target,
    props: { items: ITEMS, value: 'a', onSelect, label: 'Sections', ...props },
  });
  flushSync();
  mounted.push(() => unmount(instance));
  const tabs = () => [...target.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  return { target, onSelect, tabs };
}

it('is one named tablist with a tab per item and no scroller', () => {
  const { target, tabs } = render();
  const list = target.querySelector('[role="tablist"]')!;
  expect(list.getAttribute('aria-label')).toBe('Sections');
  expect(tabs().map((t) => t.textContent!.trim())).toEqual(['Alpha', 'Beta 4', 'Gamma']);
  expect(list.className).not.toContain('overflow');
  expect((list as HTMLElement).style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
});

it('marks the selected tab and keeps ONE tab stop (roving tabindex)', () => {
  const { tabs } = render({ value: 'b' });
  expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
});

it('selects on click', () => {
  const { tabs, onSelect } = render();
  tabs()[2].click();
  expect(onSelect).toHaveBeenCalledWith('c');
});

it('arrow keys move and select, wrapping; Home and End jump', () => {
  const { tabs, onSelect } = render();
  const press = (i: number, key: string) =>
    tabs()[i].dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press(0, 'ArrowRight');
  expect(onSelect).toHaveBeenLastCalledWith('b');
  press(0, 'ArrowLeft');
  expect(onSelect).toHaveBeenLastCalledWith('c');
  press(1, 'End');
  expect(onSelect).toHaveBeenLastCalledWith('c');
  press(2, 'Home');
  expect(onSelect).toHaveBeenLastCalledWith('a');
  onSelect.mockClear();
  press(0, 'a');
  expect(onSelect).not.toHaveBeenCalled();
});

it('wires tab and panel ids only when asked', () => {
  expect(render().tabs()[0].id).toBe('');
  document.body.innerHTML = '';
  const { tabs } = render({ idPrefix: '' });
  expect(tabs()[1].id).toBe('tab-b');
  expect(tabs()[1].getAttribute('aria-controls')).toBe('tabpanel-b');
});
