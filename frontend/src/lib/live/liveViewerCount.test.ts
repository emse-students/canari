/**
 * The viewer count a live screen may show (docs/wiki/frontend/modules/live.md, "The viewer count"):
 * a whole number from the manifest, or nothing - never a guess - and its sentence in both languages,
 * plural forms included.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveViewerCount } from './liveViewerCount';
import { m } from '$lib/paraglide/messages';

const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('liveViewerCount', () => {
  it('reads a whole number of viewers, zero included', () => {
    expect(liveViewerCount({ liveId: LIVE, viewers: 0 })).toBe(0);
    expect(liveViewerCount({ liveId: LIVE, viewers: 24 })).toBe(24);
  });

  it('shows nothing for a count the server could not read, and does not accuse it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(liveViewerCount({ liveId: LIVE, viewers: null })).toBeNull();
    // A server older than the field (a deploy in progress): absent, not broken.
    expect(liveViewerCount({ liveId: LIVE } as never)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses anything but a non-negative integer, and logs the broken contract', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const viewers of [-1, 1.5, Number.NaN, '3', ['a']]) {
      expect(liveViewerCount({ liveId: LIVE, viewers: viewers as never })).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });
});

describe('the viewer count sentence', () => {
  it('is plural in French from 2 on (0 and 1 take the singular)', () => {
    expect(m.live_viewer_count({ count: 0 }, { locale: 'fr' })).toBe('0 spectateur');
    expect(m.live_viewer_count({ count: 1 }, { locale: 'fr' })).toBe('1 spectateur');
    expect(m.live_viewer_count({ count: 2 }, { locale: 'fr' })).toBe('2 spectateurs');
  });

  it('is singular in English for 1 only', () => {
    expect(m.live_viewer_count({ count: 0 }, { locale: 'en' })).toBe('0 viewers');
    expect(m.live_viewer_count({ count: 1 }, { locale: 'en' })).toBe('1 viewer');
    expect(m.live_viewer_count({ count: 24 }, { locale: 'en' })).toBe('24 viewers');
  });
});
