/**
 * ELEVEN REACTORS SPILLED OUT OF THE FRAME (user report, 2026-10-09, post "Le Pic qui Chante").
 *
 * The panel was capped at a constant 200 px by `estimatedHeight`, had no overflow handling, and
 * closes on any scroll - so past ~7 names the rows hung below the frame over the text underneath.
 * The height now comes from the content: the names are laid out in the room the frame really has.
 *
 * happy-dom has no layout, so the geometry is stubbed with a deliberately simple model: a row is
 * 18 px, the frame's header and padding are 36 px, and a list is as tall as its rows. The real
 * engine is measured separately (design-reference, the popover section).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReactorsPanel from './ReactorsPanel.svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: (id: string) => Promise.resolve(id),
}));

const ROW = 18;
const CHROME = 36;
const mounted: (() => void)[] = [];
const restore: (() => void)[] = [];

function stub(prop: 'offsetHeight' | 'offsetTop') {
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      if (prop === 'offsetTop') return this.tagName === 'UL' ? CHROME : 0;
      if (this.tagName === 'LI') return ROW;
      if (this.tagName === 'UL') return this.children.length * ROW;
      return CHROME + (this.querySelector('ul')?.children.length ?? 0) * ROW;
    },
  });
  restore.push(() => {
    if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  });
}

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  while (restore.length) restore.pop()!();
  document.body.innerHTML = '';
});

/** A 436 x 330 screen with the badge mid-height: 144 px below it, so `maxHeight` is 160 px. */
function open(count: number) {
  stub('offsetHeight');
  stub('offsetTop');
  Object.defineProperty(window, 'innerWidth', { value: 436, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 330, configurable: true });
  const anchor = document.createElement('button');
  anchor.getBoundingClientRect = () =>
    ({ left: 40, right: 80, top: 150, bottom: 178, width: 40, height: 28 }) as DOMRect;
  document.body.appendChild(anchor);
  const app = mount(ReactorsPanel, {
    target: document.body,
    props: {
      anchor,
      emoji: '🔨',
      label: 'Marteau',
      userIds: Array.from({ length: count }, (_, i) => `Reactor ${i + 1}`),
      onClose: () => {},
    },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  flushSync();
  const panel = document.querySelector<HTMLElement>('[role="tooltip"]')!;
  panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 100 }) as DOMRect;
  return { panel, list: panel.querySelector<HTMLElement>('ul')! };
}

describe('ReactorsPanel - the frame holds every row it shows', () => {
  it('keeps one column when the names fit under the room', () => {
    const { list } = open(3);
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(list.style.gridTemplateColumns).toContain('repeat(1,');
  });

  it('lays eleven names out in columns instead of past the frame', () => {
    const { panel, list } = open(11);
    const maxH = Number.parseFloat(panel.style.maxHeight);
    expect(maxH).toBe(160);
    const rows = Number.parseInt(/repeat\((\d+),/.exec(list.style.gridTemplateRows)![1]);
    // Frame = chrome + rows: it must fit the cap, and every one of the 11 names is drawn.
    expect(CHROME + rows * ROW).toBeLessThanOrEqual(maxH);
    expect(list.querySelectorAll('li')).toHaveLength(11);
    expect(list.style.gridTemplateColumns).toContain('repeat(2,');
  });

  it('counts what cannot fit on a last line rather than drawing it outside', () => {
    const { list } = open(200);
    const items = [...list.querySelectorAll('li')];
    expect(items.length).toBeLessThan(200);
    expect(items.at(-1)!.textContent).toMatch(/\d+/);
    expect(items.at(-1)!.textContent).toMatch(/\+\d+/);
  });
});
