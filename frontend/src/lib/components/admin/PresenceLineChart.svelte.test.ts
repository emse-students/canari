// @vitest-environment happy-dom
/**
 * The line chart: one line per platform or version with its own legend entry, a legend that hides a
 * line, a readout that belongs to the point the reader chose (the window slides under it), and a
 * gap that stays a gap.
 */
import { it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CensusHistory } from '$lib/admin/presenceMonitor';
import { m } from '$lib/paraglide/messages';
import PresenceLineChart from './PresenceLineChart.svelte';

const NOW = 1_800_000_000 - (1_800_000_000 % 60);

function history(now: number): CensusHistory {
  const sample = (t: number, web: number, ios: number) => ({
    t,
    devices: web + ios,
    users: web + ios,
    groups: [
      { platform: 'web', version: '1.0.0', devices: web, users: web },
      { platform: 'ios', version: '1.0.1', devices: ios, users: ios },
    ],
  });
  return {
    now,
    intervalSecs: 60,
    windowSecs: 24 * 60 * 60,
    samples: [sample(NOW - 120, 3, 1), sample(NOW - 60, 4, 1), sample(NOW, 5, 1)],
  };
}

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(axis: 'platform' | 'version' = 'platform') {
  const props = $state({ history: history(NOW), axis });
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(PresenceLineChart, { target, props });
  mounted.push(() => unmount(instance));
  const slider = target.querySelector<HTMLElement>('[role="slider"]')!;
  return { props, slider, target };
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

it('draws a line per platform plus the dashed total, and one per version on the other axis', () => {
  const platforms = render('platform');
  expect(platforms.target.querySelectorAll('path[data-series]')).toHaveLength(3);
  expect(platforms.target.querySelector('path[data-series="total"]')).not.toBeNull();
  const versions = render('version');
  const keys = [...versions.target.querySelectorAll('path[data-series]')].map((p) =>
    p.getAttribute('data-series')
  );
  expect(keys).toEqual(['1.0.1', '1.0.0', 'total']);
});

it('hides and shows a line from its legend entry', () => {
  const { target } = render();
  const buttons = [...target.querySelectorAll<HTMLButtonElement>('ul button')];
  const web = buttons.find((b) => b.textContent?.includes('Web'))!;
  expect(web.getAttribute('aria-pressed')).toBe('true');
  web.click();
  flushSync();
  expect(web.getAttribute('aria-pressed')).toBe('false');
  expect(target.querySelector('path[data-series="web"]')).toBeNull();
  web.click();
  flushSync();
  expect(target.querySelector('path[data-series="web"]')).not.toBeNull();
});

it('shows a tooltip with the time and each series value at the hovered point', () => {
  const { slider, target } = render();
  slider.dispatchEvent(new FocusEvent('focus'));
  flushSync();
  const tip = target.querySelector('[data-testid="chart-tooltip"]')!;
  expect(tip.textContent).toContain('Web');
  expect(tip.textContent).toContain('5');
});

it('keeps the reader on the same point when the window slides', () => {
  const { props, slider } = render();
  slider.dispatchEvent(new FocusEvent('focus'));
  flushSync();
  key(slider, 'ArrowLeft'); // NOW - 60 (5 devices in all)
  const before = slider.getAttribute('aria-valuetext');
  expect(before).toContain('5');

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

it('says a gap is a gap, not a zero', () => {
  const { slider, target } = render();
  slider.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
  slider.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, bubbles: true }));
  flushSync();
  expect(target.querySelector('[data-testid="chart-tooltip"]')?.textContent).toContain(
    m.admin_status_chart_gap_point()
  );
});
