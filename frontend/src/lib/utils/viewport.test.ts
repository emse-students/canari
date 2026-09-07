import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NARROW_CHAT_QUERY,
  OVERLAY_LAYOUT_QUERY,
  SWIPE_NAV_QUERY,
  isNarrowChatLayout,
  isOverlayLayout,
  isSwipeNavViewport,
  onViewportChange,
} from './viewport';

/**
 * THE QUERIES THEMSELVES, because their whole purpose is to agree with the markup.
 *
 * A breakpoint written in a script and a `md:` class written in a template are two statements about
 * the same boundary, and nothing makes them agree. Four hand-written queries had drifted apart
 * before this module existed - two of them by a single pixel. These assertions pin the derivation,
 * and the last one fails if `app.css` ever starts overriding Tailwind's scale, which would make
 * every number here wrong at once and silently.
 */
const here = dirname(fileURLToPath(import.meta.url));

describe('the viewport queries', () => {
  it('stop one pixel BELOW the Tailwind breakpoint, where `md:`/`xl:` start', () => {
    // Tailwind emits min-width, so the complement of `md:` excludes 768 itself. `max-width: 768px`
    // - what two components used to say - claimed the phone layout on a viewport the CSS was
    // already laying out in two panes.
    expect(NARROW_CHAT_QUERY).toContain('(max-width: 767.98px)');
    expect(OVERLAY_LAYOUT_QUERY).toBe('(max-width: 1279.98px)');
    expect(SWIPE_NAV_QUERY).toContain('(max-width: 1279.98px)');
  });

  it('keep the pointer question exactly where it belongs', () => {
    // Chat panes and swiping need a finger or a narrow screen; full-screen overlays are about room
    // alone, so a narrow mouse window still gets them.
    expect(NARROW_CHAT_QUERY).toContain('(pointer: coarse)');
    expect(SWIPE_NAV_QUERY).toContain('(pointer: coarse)');
    expect(OVERLAY_LAYOUT_QUERY).not.toContain('pointer');
  });

  it('answer false rather than throwing where matchMedia cannot be asked', () => {
    const original = window.matchMedia;
    // Deliberately removing it, which is what SSR looks like from inside these helpers.
    delete (window as { matchMedia?: unknown }).matchMedia;
    try {
      expect(isNarrowChatLayout()).toBe(false);
      expect(isOverlayLayout()).toBe(false);
      expect(isSwipeNavViewport()).toBe(false);
      expect(onViewportChange(NARROW_CHAT_QUERY, () => {})).toBeTypeOf('function');
      // And the teardown it hands back must be safe to call.
      expect(() => onViewportChange(NARROW_CHAT_QUERY, () => {})()).not.toThrow();
    } finally {
      window.matchMedia = original;
    }
  });

  it('app.css overrides no Tailwind breakpoint, which is what makes 768/1280 the truth here', () => {
    const css = readFileSync(resolve(here, '../../app.css'), 'utf8');
    expect(
      css.includes('--breakpoint-'),
      'app.css now sets a --breakpoint-*: viewport.ts must read it instead of hardcoding Tailwind defaults'
    ).toBe(false);
  });
});
