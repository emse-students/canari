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
const layout = { content: 300 };
let fontsReady: () => void = () => {};
const resized: (() => void)[] = [];
let mounted: Record<string, unknown> | null = null;

beforeEach(() => {
  layout.content = 300;
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-feed-tabs') ? layout.content : 0;
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
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  if (mounted) void unmount(mounted);
  mounted = null;
  resized.length = 0;
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
  props.feed = 'all' === props.feed ? 'followed' : 'all';
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
