/**
 * THE IN-APP PICKER - a sheet on a phone, a popover on a wide window, and a listbox either way.
 *
 * It replaced native `<select>`s because Android opened its own system dialog for them (user,
 * 2026-09-29). What is pinned here is what that replacement must not lose: the choice reaches the
 * caller, picking the current option changes nothing, the shape follows the width at the moment it
 * opens, and Escape closes the picker WITHOUT reaching a modal's window-level Escape.
 */
import { it, expect, afterEach, afterAll, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import Picker from './Picker.svelte';
import { groupPickerOptions, pickerKeyTarget } from './picker';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// Every close plays an outro, and teardown cuts the last one short.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const OPTIONS = [
  { value: '', label: 'Moi' },
  { value: 'anon', label: 'Anonyme' },
  { value: 'a1', label: 'BDE', group: 'Associations' },
  { value: 'a2', label: 'BDS', group: 'Associations' },
];

function stubWidth(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query.includes('40rem'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

function mountPicker(value = '') {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onValueChange = vi.fn();
  const component = mount(Picker, {
    target,
    props: { value, options: OPTIONS, onValueChange, label: 'Publier en tant que' },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, onValueChange, trigger: target.querySelector('button')! };
}

async function open(trigger: HTMLButtonElement) {
  trigger.click();
  flushSync();
  await tick();
}

function options(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
}

it('opens as a bottom sheet on a phone, under a heading per group', async () => {
  stubWidth(true);
  const { trigger } = mountPicker();
  await open(trigger);

  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(options().map((o) => o.textContent?.trim())).toEqual(['Moi', 'Anonyme', 'BDE', 'BDS']);
  expect(document.body.textContent).toContain('Associations');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
});

it('opens as a popover, not a dialog, on a wide window', async () => {
  stubWidth(false);
  const { trigger } = mountPicker();
  await open(trigger);

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(options()).toHaveLength(4);
});

it('hands the picked value to the caller and closes', async () => {
  stubWidth(true);
  const { trigger, onValueChange } = mountPicker();
  await open(trigger);

  options()[2].click();
  flushSync();

  expect(onValueChange).toHaveBeenCalledWith('a1');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('changes nothing when the current option is picked again', async () => {
  stubWidth(true);
  const { trigger, onValueChange } = mountPicker('anon');
  await open(trigger);

  const current = options().find((o) => o.getAttribute('aria-selected') === 'true')!;
  expect(current.textContent?.trim()).toBe('Anonyme');
  expect(document.activeElement).toBe(current);
  current.click();
  flushSync();

  expect(onValueChange).not.toHaveBeenCalled();
});

it('closes on Escape without letting the key reach a modal listening on the window', async () => {
  stubWidth(true);
  const windowEscape = vi.fn();
  window.addEventListener('keydown', windowEscape);
  const { trigger } = mountPicker();
  await open(trigger);

  options()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();

  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(windowEscape).not.toHaveBeenCalled();
  window.removeEventListener('keydown', windowEscape);
});

it('groups consecutive options by heading, in the caller order', () => {
  expect(groupPickerOptions(OPTIONS).map((g) => [g.heading, g.options.length])).toEqual([
    [undefined, 2],
    ['Associations', 2],
  ]);
});

it('moves with the arrows and wraps at both ends, as a native listbox does', () => {
  expect(pickerKeyTarget('ArrowDown', 3, 4)).toBe(0);
  expect(pickerKeyTarget('ArrowUp', 0, 4)).toBe(3);
  expect(pickerKeyTarget('Home', 2, 4)).toBe(0);
  expect(pickerKeyTarget('End', 0, 4)).toBe(3);
  expect(pickerKeyTarget('a', 0, 4)).toBeNull();
});
