// @vitest-environment happy-dom
/**
 * The zone grip's keyboard path: Up and Down move one step EACH TIME, focus stays on the grip, and
 * the drag sits on the wrapper rather than the button.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ZoneGrip from './ZoneGrip.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(onMove: (delta: -1 | 1) => Promise<void> | void) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(ZoneGrip, {
    target,
    props: { zoneId: 'z1', label: 'Move Z', onMove, onDragStart: vi.fn(), onDragEnd: vi.fn() },
  });
  flushSync();
  mounted.push(() => unmount(instance));
  const button = target.querySelector('button')!;
  const press = (key: string) =>
    button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { target, button, press };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

it('reorders twice when ArrowDown is pressed twice', async () => {
  const order = ['a', 'z1', 'b'];
  const onMove = vi.fn(async (delta: -1 | 1) => {
    const from = order.indexOf('z1');
    order.splice(from, 1);
    order.splice(from + delta, 0, 'z1');
  });
  const { press, button } = render(onMove);
  button.focus();

  press('ArrowDown');
  await settle();
  expect(order).toEqual(['a', 'b', 'z1']);
  press('ArrowUp');
  await settle();
  press('ArrowUp');
  await settle();
  expect(onMove).toHaveBeenCalledTimes(3);
  expect(order).toEqual(['z1', 'a', 'b']);
  expect(document.activeElement).toBe(button);
});

it('never disables the grip while a move is written, and ignores a press during it', async () => {
  let release!: () => void;
  const onMove = vi.fn(() => new Promise<void>((r) => (release = r)));
  const { press, button } = render(onMove);

  press('ArrowDown');
  press('ArrowDown');
  flushSync();
  expect(onMove).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(false);

  release();
  await settle();
  press('ArrowDown');
  expect(onMove).toHaveBeenCalledTimes(2);
});

it('puts draggable on a wrapper, not on the button', () => {
  const { target, button } = render(vi.fn());
  const wrapper = target.querySelector('[data-zone-grip="z1"]')!;
  expect(wrapper.getAttribute('draggable')).toBe('true');
  expect(wrapper.tagName).not.toBe('BUTTON');
  expect(button.hasAttribute('draggable')).toBe(false);
});

it('ignores other keys', async () => {
  const onMove = vi.fn();
  const { press } = render(onMove);
  press('Enter');
  await settle();
  expect(onMove).not.toHaveBeenCalled();
});
