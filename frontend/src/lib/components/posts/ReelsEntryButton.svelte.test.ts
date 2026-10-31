// @vitest-environment happy-dom
/**
 * The CanaReels entry as a reader meets it (user, 2026-10-16): ONE row - the three tabs, then a
 * named clap icon at its right end - and a tap on the icon goes STRAIGHT INTO the reel viewer at the
 * newest reel. No reel yet: a sheet says so, with the camera one tap away, instead of an empty
 * viewer. The old filter bar ("Tous les posts" / "CanaReels") is gone.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import FeedTabRow from './FeedTabRow.svelte';
import type { PostEntity } from '$lib/posts/api';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The empty sheet (`Modal`) opens with a transition every case unmounts mid-flight: claimed, see
// `adoptTransitionAnimations`.
afterAll(adoptTransitionAnimations());

vi.mock('$app/paths', () => ({
  resolve: (path: string) => (path.startsWith('/') ? path : `/${path}`),
}));
vi.mock('$lib/components/reels/ReelViewer.svelte', async () => ({
  default: (await import('./ReelViewerStub.test-helper.svelte')).default,
}));
const listPosts = vi.fn((_options: unknown) => Promise.resolve([] as PostEntity[]));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: (options: unknown) => listPosts(options),
}));
const showToast = vi.fn();
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

const mounted: (() => void)[] = [];
beforeEach(() => {
  listPosts.mockReset();
  showToast.mockReset();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function renderRow() {
  const onFeed = vi.fn();
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FeedTabRow, {
    target,
    props: { feed: 'followed', onFeed, authToken: 't' },
  });
  flushSync();
  mounted.push(() => unmount(instance));
  const row = target.querySelector<HTMLElement>('[data-feed-tab-row]')!;
  const icon = row.querySelector<HTMLButtonElement>('button[data-reels-entry]')!;
  return { target, row, icon, onFeed };
}

it('draws ONE row: the three tabs, then the named clap icon at its right end', () => {
  const { target, row, icon } = renderRow();
  expect(target.querySelectorAll('[data-feed-tab-row]')).toHaveLength(1);
  expect(row.children).toHaveLength(2);
  expect(row.lastElementChild).toBe(icon);
  expect(icon.getAttribute('aria-label')).toBe(m.posts_reels_open());
  expect(icon.querySelector('svg')).not.toBeNull();
  expect(icon.textContent!.trim()).toBe('');
  const tabs = [...row.querySelectorAll<HTMLButtonElement>('[data-feed-tabs] button')];
  expect(tabs.map((b) => b.textContent!.trim())).toEqual([
    m.posts_tab_associations(),
    m.posts_tab_followed(),
    m.posts_tab_all(),
  ]);
  expect(tabs.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  // No second bar, no filter control: nothing on the row is a tablist or a toggle.
  expect(target.querySelector('[role="tablist"]')).toBeNull();
  expect(icon.hasAttribute('aria-pressed')).toBe(false);
});

it('at a narrow width the TABS scroll and the icon stays: the row never wraps', () => {
  // happy-dom has no layout, so this pins the classes that decide it: a row that cannot wrap, a
  // tab strip that may shrink below its content and scrolls, pills and icon that keep their size.
  const { row, icon } = renderRow();
  const tabs = row.querySelector<HTMLElement>('[data-feed-tabs]')!;
  expect(row.classList).not.toContain('flex-wrap');
  expect(tabs.classList).toContain('min-w-0');
  expect(tabs.classList).toContain('overflow-x-auto');
  for (const pill of tabs.querySelectorAll('button')) {
    expect(pill.classList).toContain('shrink-0');
    expect(pill.classList).toContain('whitespace-nowrap');
  }
  // The app's icon-button box (`ui-icon-button`: 44 px touch, 38 px pointer, never shrinks).
  expect(icon.classList).toContain('ui-icon-button');
});

it('the tabs sit in ONE glass pill and the reels entry is a matching glass button, no band', () => {
  const { row, icon } = renderRow();
  const pill = row.querySelector<HTMLElement>('[data-feed-pill]')!;
  expect(pill.classList).toContain('glass-chrome');
  expect(pill.classList).toContain('rounded-full');
  expect(pill.querySelectorAll('[data-feed-tab]')).toHaveLength(3);
  expect(icon.classList).toContain('glass-chrome');
  expect(row.className).not.toMatch(/\bbg-/);
});

it('a tab tap is handed to the page', () => {
  const { row, onFeed } = renderRow();
  row.querySelector<HTMLButtonElement>('[data-feed-tabs] button')!.click();
  expect(onFeed).toHaveBeenCalledWith('associations');
});

it('the icon opens the viewer at the newest reel, across every tab', async () => {
  listPosts.mockResolvedValueOnce([{ id: 'newest' }, { id: 'older' }] as PostEntity[]);
  const { icon } = renderRow();
  icon.click();
  await settle();
  expect(listPosts).toHaveBeenCalledWith({
    kind: 'reel',
    singlePhotos: true,
    feed: 'all',
    offset: 0,
    limit: 10,
  });
  expect(
    document.querySelector('[data-reel-viewer-stub]')?.getAttribute('data-reel-viewer-stub')
  ).toBe('newest');
  expect(document.querySelector('[data-reels-empty]')).toBeNull();
});

it('with no reel yet, a sheet says so and offers the camera - no empty viewer', async () => {
  listPosts.mockResolvedValueOnce([]);
  const { icon } = renderRow();
  icon.click();
  await settle();
  expect(document.querySelector('[data-reel-viewer-stub]')).toBeNull();
  const empty = document.querySelector('[data-reels-empty]')!;
  expect(empty.textContent).toContain(m.posts_reels_empty_title());
  expect(empty.querySelector('a')?.getAttribute('href')).toBe('/camera');
});

it('offline: says so, opens nothing, and accuses nobody', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  listPosts.mockRejectedValueOnce(new TransportFailureError('Failed to fetch'));
  const { icon } = renderRow();
  icon.click();
  await settle();
  expect(showToast).toHaveBeenCalledWith(m.posts_reels_open_error(), 'error');
  expect(document.querySelector('[data-reel-viewer-stub]')).toBeNull();
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});

it('a refusal from the server is logged as the defect it is', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  listPosts.mockRejectedValueOnce(new Error('500'));
  const { icon } = renderRow();
  icon.click();
  await settle();
  expect(showToast).toHaveBeenCalledWith(m.posts_reels_open_error(), 'error');
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
