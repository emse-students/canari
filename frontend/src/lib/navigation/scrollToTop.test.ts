// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handlePlaceClick,
  handlePlaceTap,
  isPlaceRetap,
  registerRetapRefresh,
  scrollPageToTop,
} from './scrollToTop';
import { STATUS_BAR_TAP_EVENT } from '$lib/mobile/nativeStatusBarTap';

// The overlay stack is its own module with its own tests: here only its depth and its drain matter.
const overlays = vi.hoisted(() => ({ depth: 0, drain: vi.fn() }));
vi.mock('$lib/utils/historyOverlayStack', () => ({
  historyOverlayStackDepth: () => overlays.depth,
  drainHistoryOverlayStack: () => {
    overlays.drain();
    overlays.depth = 0;
  },
}));

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
  overlays.depth = 0;
  overlays.drain.mockReset();
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

  it('reports already-at-top and never refreshes by itself (the caller decides)', () => {
    const refresh = vi.fn();
    const unregister = registerRetapRefresh(refresh);
    const { scrollTo } = mountScroller(0);
    expect(scrollPageToTop('tab-retap')).toBe('already-at-top');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    unregister();
  });

  it('a status bar tap with an overlay open leaves the page behind it alone', () => {
    const { scrollTo } = mountScroller(900);
    overlays.depth = 1;
    expect(scrollPageToTop('status-bar')).toBe('overlay-open');
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

  it('first re-tap scrolls WITHOUT refreshing; a re-tap at the top refreshes', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const unregister = registerRetapRefresh(refresh);
    const { el, scrollTo } = mountScroller(500);
    handlePlaceTap('/posts', '/posts');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    el.scrollTop = 0;
    handlePlaceTap('/posts', '/posts');
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalledTimes(1);
    unregister();
    handlePlaceTap('/posts', '/posts');
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a re-tap closes open overlays first and goes no further', () => {
    const refresh = vi.fn();
    const unregister = registerRetapRefresh(refresh);
    const { scrollTo } = mountScroller(500);
    overlays.depth = 2;
    expect(handlePlaceTap('/posts', '/posts')).toBe(true);
    expect(overlays.drain).toHaveBeenCalledTimes(1);
    expect(scrollTo).not.toHaveBeenCalled();
    unregister();
  });

  it('repeated re-taps at the top start ONE refresh at a time', async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const unregister = registerRetapRefresh(refresh);
    mountScroller(0);
    handlePlaceTap('/posts', '/posts');
    handlePlaceTap('/posts', '/posts');
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    handlePlaceTap('/posts', '/posts');
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    finish();
    unregister();
  });

  it('a failed refresh is warned about, not swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unregister = registerRetapRefresh(() => Promise.reject(new Error('boom')));
    mountScroller(0);
    handlePlaceTap('/posts', '/posts');
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    unregister();
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

describe('a click on a place link', () => {
  const click = (init: MouseEventInit) =>
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });

  it('cancels the navigation of a plain primary re-click only', () => {
    mountScroller(500);
    const plain = click({});
    handlePlaceClick(plain, '/posts', '/posts');
    expect(plain.defaultPrevented).toBe(true);
    const elsewhere = click({});
    handlePlaceClick(elsewhere, '/chat', '/posts');
    expect(elsewhere.defaultPrevented).toBe(false);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])(
    'leaves a modified or middle click to the browser (%o)',
    (init) => {
      const { scrollTo } = mountScroller(500);
      const e = click(init);
      handlePlaceClick(e, '/posts', '/posts');
      expect(e.defaultPrevented).toBe(false);
      expect(scrollTo).not.toHaveBeenCalled();
    }
  );

  it('both web bars and the feed wire the re-tap through the shared handlers', () => {
    const read = (p: string) => readFileSync(p, 'utf8');
    for (const bar of ['BottomNav', 'AppSidebar']) {
      expect(read(`src/lib/components/navigation/${bar}.svelte`)).toContain(
        'onclick={(e) => handlePlaceClick(e, place.href, pathname)}'
      );
    }
    const feed = read('src/routes/posts/+page.svelte');
    expect(feed).toContain('registerRetapRefresh(refreshPosts)');
    expect(feed).toMatch(/unregisterRetap\(\);/);
  });
});

describe('the iOS status bar bridge', () => {
  const PLUGIN = 'src-tauri/patches/tauri-plugin-system-components/ios/Sources/';

  it('the Swift side triggers the event name the page listens for', () => {
    const swift = readFileSync(`${PLUGIN}SystemComponentsPlugin.swift`, 'utf8');
    expect(swift).toContain(`trigger("${STATUS_BAR_TAP_EVENT}"`);
  });

  it('the catcher is a full-width strip pinned to the top, not a corner', () => {
    const overlay = readFileSync(`${PLUGIN}TabBarOverlay.swift`, 'utf8');
    for (const edge of ['topAnchor', 'leadingAnchor', 'trailingAnchor']) {
      expect(overlay).toContain(`statusBarTapCatcher.${edge}.constraint(equalTo: view.${edge})`);
    }
    expect(overlay).toContain('statusBarTapCatcher.heightAnchor.constraint(equalToConstant: 1)');
  });

  it('the catcher refuses the native scroll and the web view gives up its own', () => {
    const overlay = readFileSync(`${PLUGIN}TabBarOverlay.swift`, 'utf8');
    expect(overlay).toMatch(/scrollViewShouldScrollToTop[\s\S]*?return false/);
    const plugin = readFileSync(`${PLUGIN}SystemComponentsPlugin.swift`, 'utf8');
    expect(plugin).toContain('webView?.scrollView.scrollsToTop = false');
  });
});
