// @vitest-environment happy-dom
/** The feed's (i) button opens a surface that explains all three tabs, and closes again. */
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FeedTabsInfo from './FeedTabsInfo.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = '';
});

it('explains the three tabs when opened and hides them when closed', () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia;
  mounted = mount(FeedTabsInfo, { target: document.body });
  const button = document.querySelector<HTMLButtonElement>('[data-feed-tabs-info]')!;
  expect(document.body.textContent).not.toContain(m.posts_tabs_info_all_body());
  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  for (const text of [
    m.posts_tabs_info_associations_body(),
    m.posts_tabs_info_followed_body(),
    m.posts_tabs_info_all_body(),
  ]) {
    expect(document.body.textContent).toContain(text);
  }
  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('false');
});
