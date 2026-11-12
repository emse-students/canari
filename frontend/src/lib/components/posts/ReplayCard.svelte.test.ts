// @vitest-environment happy-dom
/**
 * The replay card in the feed: says what it is, plays nothing, and a tap opens the viewer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReplayCard from './ReplayCard.svelte';
import type { PostEntity } from '$lib/posts/api';

vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy(
    {},
    { get: (_t, key) => (p?: unknown) => `${String(key)}${p ? JSON.stringify(p) : ''}` }
  ),
}));

const mounted: Record<string, unknown>[] = [];
function render(post: Partial<PostEntity>, onOpen = vi.fn(), loadCover?: unknown) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReplayCard, {
      target,
      props: {
        post: { id: 'p1', kind: 'replay', ...post } as PostEntity,
        onOpen,
        loadCover: loadCover as never,
      },
    })
  );
  flushSync();
  return { target, onOpen };
}
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ReplayCard', () => {
  it('shows the mark and the length, and no time left without the server clock', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { target } = render({ durationMs: 754_000, markdown: 'Soiree BDE' });
    expect(target.querySelector('[data-replay-card-badge]')?.textContent).toContain('replay_badge');
    expect(target.querySelector('[data-replay-card-duration]')?.textContent).toBe('12:34');
    expect(target.textContent).not.toContain('time_left');
    // The live title is the post caption, drawn by the post: the card adds no second one.
    expect(target.querySelector('[data-replay-card-title]')).toBeNull();
  });
  it('draws the house glass play triangle, not a disc with a Lucide icon', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { target } = render({ durationMs: 1000 });
    expect(target.querySelector('[data-video-glass-glyph="play"]')).not.toBeNull();
  });
  it('names the live when it had no title', () => {
    const { target } = render({ durationMs: 60_000, markdown: '' });
    expect(target.querySelector('[data-replay-card-title]')?.textContent).toContain(
      'replay_card_default_title'
    );
  });
  it('opens the viewer on a tap', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { target, onOpen } = render({ durationMs: 1000 });
    (target.querySelector('[data-replay-card]') as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it('draws the time left from the row own pair of database times, never the phone clock', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    // The phone's clock is days off: the number still comes from the server's pair.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00.000Z'));
    const { target } = render({
      durationMs: 60_000,
      expiresAt: '2026-11-12T10:00:00.000Z',
      serverNow: '2026-11-10T08:00:00.000Z',
    });
    expect(target.querySelector('[data-replay-card-time-left]')?.textContent).toContain(
      'replay_time_left_days{"count":2}'
    );
  });
  it('covers the card with the live last preview, loaded under the live id', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:cover');
    URL.revokeObjectURL = vi.fn();
    const loadCover = vi.fn(async () => ({ kind: 'shown' as const, image: new Blob(['x']) }));
    const { target } = render(
      { liveId: 'live-1', poster: { name: 'poster-1', ageMs: 5 }, posterKey: 'pk' },
      vi.fn(),
      loadCover
    );
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(loadCover).toHaveBeenCalledWith(
      { id: 'live-1', poster: { name: 'poster-1', ageMs: 5 }, posterKey: 'pk' },
      expect.anything()
    );
    expect(target.querySelector('[data-live-poster-image]')?.getAttribute('src')).toBe(
      'blob:cover'
    );
  });
  it('keeps the dark box when the live stored no preview', () => {
    const { target } = render({ liveId: 'live-1', poster: null, posterKey: null });
    expect(target.querySelector('[data-replay-card-cover]')).toBeNull();
  });
});
