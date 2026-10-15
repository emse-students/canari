/**
 * The CanaReels filter as a reader meets it: two fixed tabs, "Tout" and "CanaReels", the selected
 * one marked, a tap handing the choice up - and the empty filtered feed saying so, with the camera
 * one tap away.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FeedKindFilter from './FeedKindFilter.svelte';
import ReelsEmptyState from './ReelsEmptyState.svelte';
import { m } from '$lib/paraglide/messages';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function renderFilter(value: 'all' | 'reel') {
  const onSelect = vi.fn();
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FeedKindFilter, { target, props: { value, onSelect } });
  flushSync();
  mounted.push(() => unmount(instance));
  const tabs = [...target.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  return { target, onSelect, tabs };
}

it('draws "Tout" and "CanaReels" as one named tablist, the current one selected', () => {
  const { target, tabs } = renderFilter('reel');
  expect(target.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
    m.posts_filter_aria()
  );
  expect(tabs.map((t) => t.textContent!.trim())).toEqual([
    m.posts_filter_all(),
    m.posts_filter_reels(),
  ]);
  expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
});

it('hands the picked filter up, and decides nothing itself', () => {
  const { onSelect, tabs } = renderFilter('all');
  tabs[1].click();
  expect(onSelect).toHaveBeenCalledWith('reel');
  tabs[0].click();
  expect(onSelect).toHaveBeenLastCalledWith('all');
});

it('the empty CanaReels view says so and links to the camera', () => {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(ReelsEmptyState, { target });
  flushSync();
  mounted.push(() => unmount(instance));
  expect(target.textContent).toContain(m.posts_reels_empty_title());
  const link = target.querySelector('a');
  expect(link?.getAttribute('href')).toBe('/camera');
  expect(link?.textContent?.trim()).toBe(m.posts_reels_empty_camera());
});
