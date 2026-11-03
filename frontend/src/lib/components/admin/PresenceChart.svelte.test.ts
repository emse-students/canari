// @vitest-environment happy-dom
/**
 * The chart's readout belongs to the minute the reader chose, not to a position: the page refreshes
 * the history every 60 s and the window slides one minute each time.
 */
import { it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CensusHistory } from '$lib/admin/presenceMonitor';
import PresenceChart from './PresenceChart.svelte';

const NOW = 1_800_000_000 - (1_800_000_000 % 60);

function history(now: number): CensusHistory {
  const sample = (t: number, devices: number) => ({
    t,
    devices,
    users: devices,
    groups: [{ platform: 'web', version: '1.0.0', devices, users: devices }],
  });
  return {
    now,
    intervalSecs: 60,
    windowSecs: 24 * 60 * 60,
    samples: [sample(NOW - 120, 3), sample(NOW - 60, 4), sample(NOW, 5)],
  };
}

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render() {
  const props = $state({ history: history(NOW) });
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(PresenceChart, { target, props });
  mounted.push(() => unmount(instance));
  const slider = target.querySelector<HTMLElement>('[role="slider"]')!;
  return { props, slider };
}

const key = (el: HTMLElement, name: string) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  flushSync();
};

it('is read-only, and announces its value once (the slider, not a live region)', () => {
  const { slider } = render();
  expect(slider.getAttribute('aria-readonly')).toBe('true');
  expect(document.querySelector('[aria-live]')).toBeNull();
});

it('keeps the reader on the same minute when the window slides', () => {
  const { props, slider } = render();
  slider.dispatchEvent(new FocusEvent('focus'));
  flushSync();
  key(slider, 'ArrowLeft'); // NOW - 60 (4 devices)
  const before = slider.getAttribute('aria-valuetext');
  expect(before).toContain('4');

  // The 60 s refresh: one minute later, the same samples plus a new one.
  props.history = {
    ...history(NOW + 60),
    samples: [...history(NOW).samples, { t: NOW + 60, devices: 9, users: 9, groups: [] }],
  };
  flushSync();

  expect(slider.getAttribute('aria-valuetext')).toBe(before);
});

it('keeps the readout while the keyboard holds focus and the pointer leaves', () => {
  const { slider } = render();
  slider.dispatchEvent(new FocusEvent('focus'));
  flushSync();
  const shown = slider.getAttribute('aria-valuetext');
  expect(shown).not.toBe('');

  slider.dispatchEvent(new Event('pointerleave'));
  flushSync();
  expect(slider.getAttribute('aria-valuetext')).toBe(shown);

  slider.dispatchEvent(new FocusEvent('blur'));
  flushSync();
  expect(slider.getAttribute('aria-valuetext')).toBe('');
});

it('clears on pointer leave when nothing holds focus', () => {
  const { slider } = render();
  slider.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
  slider.dispatchEvent(new MouseEvent('pointermove', { clientX: 99, bubbles: true }));
  flushSync();
  expect(slider.getAttribute('aria-valuetext')).not.toBe('');
  slider.dispatchEvent(new Event('pointerleave'));
  flushSync();
  expect(slider.getAttribute('aria-valuetext')).toBe('');
});
