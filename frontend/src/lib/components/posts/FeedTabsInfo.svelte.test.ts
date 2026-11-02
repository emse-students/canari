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

/** Mounts the button with `matchMedia` answering `sheet`, and returns it. */
function render(sheet: boolean): HTMLButtonElement {
  window.matchMedia = vi.fn().mockReturnValue({ matches: sheet }) as unknown as typeof matchMedia;
  mounted = mount(FeedTabsInfo, { target: document.body });
  return document.querySelector<HTMLButtonElement>('[data-feed-tabs-info]')!;
}

it('explains the three tabs when opened and hides them when closed', () => {
  const button = render(true);
  expect(document.body.textContent).not.toContain(m.posts_tabs_info_all_body());
  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
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

it('on a wide window it is a labelled group, not a dialog', () => {
  const button = render(false);
  button.click();
  flushSync();
  expect(button.getAttribute('aria-haspopup')).toBe('true');
  expect(document.querySelector('[role="group"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('Escape closes it and returns focus to the (i) button', () => {
  const button = render(false);
  button.click();
  flushSync();
  const panel = document.querySelector<HTMLElement>('[role="group"]')!;
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
});
