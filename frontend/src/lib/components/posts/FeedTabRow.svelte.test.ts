// @vitest-environment happy-dom
/**
 * The feed's tab row keeps the SELECTED tab in full view: on arrival, on a selection, and when the
 * row's layout changes under it - the web font arriving after the first layout, or a resize (Mi 9T,
 * v1.2.9-alpha.4: at 2x text the tab then called "Tout" sat under the faded edge by the CanaReels icon).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('./ReelsEntryButton.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));

import FeedTabRow from './FeedTabRow.svelte';

/** The row's layout, as the test sets it: 300 px of row over `content` px of tabs. */
const layout: { content: number; compact: number | null } = { content: 300, compact: null };
let fontsReady: () => void = () => {};
const resized: (() => void)[] = [];
/** Every element a `ResizeObserver` was asked to watch, whichever observer. */
const watched = new Set<Element>();
let mounted: Record<string, unknown> | null = null;

beforeEach(() => {
  layout.content = 300;
  layout.compact = null;
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (!this.hasAttribute('data-feed-tabs')) return 0;
    return this.hasAttribute('data-compact') && layout.compact !== null
      ? layout.compact
      : layout.content;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-feed-tabs') ? 300 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    // "Mon espace" (then "Tout") is the last tab: 300-420 in the content, measured with the row unscrolled.
    const tab = this.getAttribute('data-feed-tab');
    const box = tab === 'all' ? { left: 300, width: 120 } : { left: 0, width: 300 };
    return { ...box, right: box.left + box.width, top: 0, bottom: 0, height: 0 } as DOMRect;
  });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: new Promise<void>((resolve) => (fontsReady = resolve)) },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe(el: Element) {
        watched.add(el);
      }
      unobserve(el: Element) {
        watched.delete(el);
      }
      disconnect() {}
    }
  );
});

afterEach(() => {
  if (mounted) void unmount(mounted);
  mounted = null;
  resized.length = 0;
  watched.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render() {
  const target = document.createElement('div');
  document.body.append(target);
  mounted = mount(FeedTabRow, {
    target,
    props: { feed: 'all', onFeed: () => {}, authToken: 't' },
  });
  flushSync();
  return target.querySelector<HTMLElement>('[data-feed-tabs]')!;
}

it('scrolls the selected last tab flush with the end on arrival', () => {
  layout.content = 420;
  const row = render();
  expect(row.scrollLeft).toBe(120);
});

it('reveals the tab again once the web font has laid the row out wider', async () => {
  const row = render();
  expect(row.scrollLeft).toBe(0);
  layout.content = 420;
  fontsReady();
  await Promise.resolve();
  await Promise.resolve();
  expect(row.scrollLeft).toBe(120);
});

it('reveals the tab again when the row is resized', () => {
  const row = render();
  layout.content = 420;
  resized.forEach((callback) => callback());
  expect(row.scrollLeft).toBe(120);
});

it('draws no pill until the active tab has been measured, then places it on that tab', () => {
  const left = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get');
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
  left.mockReturnValue(0);
  width.mockReturnValue(0);
  const row = render();
  expect(row.querySelector('[data-feed-tab-pill]')).toBeNull();
  left.mockReturnValue(300);
  width.mockReturnValue(120);
  resized.forEach((callback) => callback());
  flushSync();
  const pill = row.querySelector<HTMLElement>('[data-feed-tab-pill]')!;
  expect(pill.style.width).toBe('120px');
  expect(pill.style.transform).toContain('300px');
  // The accent FILL, with the ink label on it (the pill alone is 1.66:1 on the bar).
  expect(pill.classList.contains('bg-accent')).toBe(true);
  expect(row.querySelector('[aria-pressed="true"]')!.classList.contains('text-on-accent')).toBe(
    true
  );
});

it('stacks every label above the pill explicitly, and keeps the pill off a 3D layer', () => {
  // iPhone 12, 1.6.9-alpha.4: a `translate3d` pill was drawn OVER its label by iOS WebKit inside
  // the masked scroller, though the labels come after it in the DOM. The order is stated, not implied.
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120);
  const row = render();
  const pill = row.querySelector<HTMLElement>('[data-feed-tab-pill]')!;
  expect(row.classList.contains('isolate')).toBe(true);
  expect(pill.classList.contains('z-0')).toBe(true);
  expect(pill.style.transform).toBe('translateX(300px)');
  const labels = row.querySelectorAll<HTMLElement>('[data-feed-tab]');
  expect(labels.length).toBe(3);
  labels.forEach((label) => expect(label.classList.contains('z-1')).toBe(true));
});

it('never draws an ink label on the glass: not before the pill is measured, not during the slide', () => {
  const left = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get');
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
  left.mockReturnValue(0);
  width.mockReturnValue(0);
  const props = $state({ feed: 'all' as string, onFeed: () => {}, authToken: 't' });
  const target = document.createElement('div');
  document.body.append(target);
  mounted = mount(FeedTabRow, { target, props: props as never });
  flushSync();
  const label = (feed: string) => target.querySelector<HTMLElement>(`[data-feed-tab="${feed}"]`)!;
  // Pill not measured yet: the selected label is muted, not ink.
  expect(label('all').classList.contains('text-on-accent')).toBe(false);
  // First measure (no transition): the pill is under its label at once.
  left.mockReturnValue(300);
  width.mockReturnValue(120);
  resized.forEach((callback) => callback());
  flushSync();
  expect(label('all').classList.contains('text-on-accent')).toBe(true);
  // A new selection slides the pill: the leaving label goes muted, the arriving one waits.
  left.mockReturnValue(0);
  width.mockReturnValue(100);
  props.feed = 'all' === props.feed ? 'foryou' : 'all';
  flushSync();
  const arriving = label(props.feed);
  expect(label('all').classList.contains('text-on-accent')).toBe(false);
  expect(arriving.classList.contains('text-on-accent')).toBe(false);
  // The slide ends: the label turns ink.
  const pill = target.querySelector<HTMLElement>('[data-feed-tab-pill]')!;
  const end = new Event('transitionend');
  Object.defineProperty(end, 'propertyName', { value: 'transform' });
  pill.dispatchEvent(end);
  flushSync();
  expect(arriving.classList.contains('text-on-accent')).toBe(true);
});

it('keeps its labels tight enough for 360-390 px: 10 px padding, one text step down when the row is crowded', () => {
  mounted = mount(FeedTabRow, {
    target: document.body,
    props: { feed: 'all', onFeed: () => {}, authToken: 't' },
  });
  flushSync();
  const tab = document.querySelector<HTMLElement>('[data-feed-tab="all"]')!;
  expect(tab.className).toContain('px-2.5');
  expect(tab.className).not.toContain('px-3.5');
  expect(tab.className).toContain('group-data-compact/tabs:text-xs');
  expect(tab.className).not.toContain('max-[24rem]');
  expect(tab.className).not.toContain('snap-');
  // A tab is as wide as its label asks (basis auto, so a short label never takes a third), and it
  // may shrink to ANY width and break inside a word as the Thème control's segment does (Mi 9T,
  // `font_scale` 2.0: a min-content floor made the row overflow, the selected middle tab centred and
  // "Organisations" slid under the start fade as "rganisations"). Nothing overflows, so nothing scrolls.
  const classes = tab.className.split(' ');
  expect(classes).not.toContain('whitespace-nowrap');
  expect(classes).toContain('flex-auto');
  expect(classes).not.toContain('flex-1');
  expect(classes).toContain('min-w-0');
  expect(classes).not.toContain('min-w-min');
  expect(classes).toContain('[overflow-wrap:anywhere]');
  expect(classes).toContain('break-words');
  expect(classes).toContain('hyphens-auto');
});

it('steps the text down only when the row overflows at the normal size, and back when room returns', () => {
  layout.content = 340;
  layout.compact = 280;
  const row = render();
  expect(row.hasAttribute('data-compact')).toBe(true);
  // Room returns (a smaller font): measured at the NORMAL size again, so the step is released.
  layout.content = 290;
  resized.forEach((callback) => callback());
  expect(row.hasAttribute('data-compact')).toBe(false);
  layout.content = 340;
  resized.forEach((callback) => callback());
  expect(row.hasAttribute('data-compact')).toBe(true);
});

it('re-decides when only the TEXT changed (a font scale: same row width, wider tabs)', () => {
  const row = render();
  expect(row.hasAttribute('data-compact')).toBe(false);
  layout.content = 340;
  // The row itself did not resize: the callbacks registered by observing each tab fire.
  resized.forEach((callback) => callback());
  expect(row.hasAttribute('data-compact')).toBe(true);
});

it('re-decides once the web font has loaded', async () => {
  const row = render();
  layout.content = 340;
  fontsReady();
  await Promise.resolve();
  await Promise.resolve();
  expect(row.hasAttribute('data-compact')).toBe(true);
});

it('logs a compact change once, not on every observer callback', () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  layout.content = 340;
  render();
  const crowded = () => debug.mock.calls.filter((c) => String(c[0]).includes('crowded')).length;
  expect(crowded()).toBe(1);
  resized.forEach((callback) => callback());
  resized.forEach((callback) => callback());
  expect(crowded()).toBe(1);
});

it('observes every tab, whatever order the row and its tabs render in (Svelte 5.59)', async () => {
  const row = render();
  await Promise.resolve();
  const tabs = [...row.querySelectorAll('[data-feed-tab]')];
  expect(tabs.length).toBeGreaterThan(1);
  for (const tab of tabs) expect(watched.has(tab)).toBe(true);
});
