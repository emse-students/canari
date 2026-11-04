// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePlaceTap, isPlaceRetap, registerRetapRefresh, scrollPageToTop } from './scrollToTop';
import { STATUS_BAR_TAP_EVENT } from '$lib/mobile/nativeStatusBarTap';

/** Mounts a stand-in for the layout's page scroller at a given offset. */
function mountScroller(scrollTop: number) {
  const el = document.createElement('div');
  el.className = 'page-scroll-wrap';
  el.scrollTop = scrollTop;
  const scrollTo = vi.fn();
  el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
  document.body.appendChild(el);
  return { el, scrollTo };
}

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('scrollPageToTop - the one action behind every trigger', () => {
  it('scrolls the page scroller to the top, smoothly', () => {
    const { scrollTo } = mountScroller(900);
    expect(scrollPageToTop('tab-retap')).toBe('scrolled');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('jumps instead of animating when the reader asked for reduced motion', () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
    })) as unknown as typeof window.matchMedia;
    const { scrollTo } = mountScroller(900);
    scrollPageToTop('status-bar');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('does nothing more when already at the top (no refresh convention to follow)', () => {
    const { scrollTo } = mountScroller(0);
    expect(scrollPageToTop('tab-retap')).toBe('already-at-top');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('reports a missing scroller instead of throwing', () => {
    expect(scrollPageToTop('status-bar')).toBe('no-scroller');
  });
});

describe('a re-tap of a place', () => {
  it('is a tap on the place whose own page is open, trailing slash aside', () => {
    expect(isPlaceRetap('/posts', '/posts')).toBe(true);
    expect(isPlaceRetap('/posts', '/posts/')).toBe(true);
  });

  it('is not a tap from deeper in the place or from another place', () => {
    expect(isPlaceRetap('/posts', '/posts/abc')).toBe(false);
    expect(isPlaceRetap('/posts', '/chat')).toBe(false);
  });

  it('scrolls and swallows the navigation on a re-tap, and lets any other tap navigate', () => {
    const { scrollTo } = mountScroller(500);
    expect(handlePlaceTap('/chat', '/posts')).toBe(false);
    expect(handlePlaceTap('/posts', '/posts/abc')).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(handlePlaceTap('/posts', '/posts')).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('first re-tap scrolls WITHOUT refreshing; a re-tap at the top refreshes', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const unregister = registerRetapRefresh(refresh);
    const { el, scrollTo } = mountScroller(500);
    handlePlaceTap('/posts', '/posts');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    el.scrollTop = 0;
    handlePlaceTap('/posts', '/posts');
    expect(refresh).toHaveBeenCalledTimes(1);
    unregister();
    handlePlaceTap('/posts', '/posts');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a status bar tap at the top never refreshes', () => {
    const refresh = vi.fn();
    const unregister = registerRetapRefresh(refresh);
    mountScroller(0);
    scrollPageToTop('status-bar');
    expect(refresh).not.toHaveBeenCalled();
    unregister();
  });
});

describe('the iOS status bar bridge', () => {
  const PLUGIN = 'src-tauri/patches/tauri-plugin-system-components/ios/Sources/';

  it('the Swift side triggers the event name the page listens for', () => {
    const swift = readFileSync(`${PLUGIN}SystemComponentsPlugin.swift`, 'utf8');
    expect(swift).toContain(`trigger("${STATUS_BAR_TAP_EVENT}"`);
  });

  it('the catcher refuses the native scroll and the web view gives up its own', () => {
    const overlay = readFileSync(`${PLUGIN}TabBarOverlay.swift`, 'utf8');
    expect(overlay).toMatch(/scrollViewShouldScrollToTop[\s\S]*?return false/);
    const plugin = readFileSync(`${PLUGIN}SystemComponentsPlugin.swift`, 'utf8');
    expect(plugin).toContain('webView?.scrollView.scrollsToTop = false');
  });
});
