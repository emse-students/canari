// @vitest-environment happy-dom
/**
 * The reel viewer as a reader meets it: the touched reel first and playing, the next one preloaded
 * but silent, the next page asked for near the end, a step down and back, and the X closing it. The
 * media layer is replaced (`PostMedia`, `ReelPreload`); reduced motion makes every step land at once,
 * so nothing waits on a transition or a clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';
import { timeAgo } from '$lib/utils/time';
import { m } from '$lib/paraglide/messages';

const preloads: string[] = [];
const stopped: string[] = [];
vi.mock('$lib/reels/reelPreload', () => ({
  ReelPreload: class {
    #id: string;
    constructor(ref: { mediaId: string }) {
      this.#id = ref.mediaId;
      preloads.push(ref.mediaId);
    }
    stop() {
      stopped.push(this.#id);
    }
  },
}));
const captured: string[] = [];
vi.mock('$lib/reels/reelPosters.svelte', () => ({
  reelPosterUrl: () => null,
  captureReelPoster: vi.fn(async (mediaId: string) => void captured.push(mediaId)),
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

function reel(id: string): PostEntity {
  return {
    id,
    kind: 'reel',
    markdown: `caption ${id}`,
    mentions: [],
    links: [],
    media: [
      { type: 'video', mediaId: `m-${id}`, key: 'k', iv: 'i', mimeType: 'video/mp4', size: 1 },
    ],
    images: [],
    polls: [],
    authorFirstName: 'Ada',
    authorLastName: 'L',
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const mounted: Record<string, unknown>[] = [];

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(loadPage = vi.fn(async () => [reel('a'), reel('b'), reel('c')])) {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelViewer, {
      target,
      props: { startPost: reel('b'), authToken: 'tok', onClose, loadPage },
    })
  );
  await settle();
  const playing = () =>
    [...document.querySelectorAll('[data-post-media-stub]')].map((e) =>
      e.getAttribute('data-post-media-stub')
    );
  const key = async (k: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    await settle();
  };
  /** The reel on screen reports its file whole, then its playback - what lets the next preload. */
  const settleCurrent = async () => {
    const stub = document.querySelector('[data-post-media-stub]')!;
    stub.dispatchEvent(new Event('stubloaded'));
    stub.dispatchEvent(new Event('playing'));
    await settle();
  };
  return { onClose, loadPage, playing, key, settleCurrent };
}

beforeEach(() => {
  preloads.length = 0;
  stopped.length = 0;
  captured.length = 0;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ReelViewer', () => {
  it('plays the touched reel first, alone, and preloads the next once it has settled', async () => {
    const { playing, loadPage, settleCurrent } = await render();
    expect(loadPage).toHaveBeenCalledWith(0, 10);
    // b first, then a and c from the page (b not repeated); only b has a player.
    expect(playing()).toEqual(['m-b']);
    // Nothing competes with the reel being watched until it is whole and playing.
    expect(preloads).toEqual([]);
    await settleCurrent();
    expect(preloads).toEqual(['m-a']);
    // The reel just loaded keeps its first frame, so a swipe back lands on it.
    expect(captured).toEqual(['m-b']);
    expect(document.querySelectorAll('[data-reel-slide]').length).toBe(2);
  });

  it('steps down to the next reel and back up', async () => {
    const { playing, key, settleCurrent } = await render();
    await settleCurrent();
    await key('ArrowDown');
    expect(playing()).toEqual(['m-a']);
    expect(stopped).toContain('m-a');
    expect(preloads).not.toContain('m-c');
    await settleCurrent();
    expect(preloads).toContain('m-c');
    await key('ArrowUp');
    expect(playing()).toEqual(['m-b']);
  });

  it('while the caption is unfolded, the arrow keys scroll its text and do not turn the reel', async () => {
    const { playing, key } = await render();
    // `ReelSlide` marks its unfolded text `data-reel-caption-open`: that mark is the contract.
    const caption = document.createElement('div');
    caption.setAttribute('data-reel-caption-open', '');
    const scrollBy = vi.fn();
    caption.scrollBy = scrollBy as unknown as typeof caption.scrollBy;
    document.querySelector('[data-reel-slide="b"]')!.appendChild(caption);
    await key('ArrowDown');
    await key('PageUp');
    expect(playing()).toEqual(['m-b']);
    expect(scrollBy).toHaveBeenCalledTimes(2);
    expect(scrollBy.mock.calls[0][0].top).toBeGreaterThan(0);
    expect(scrollBy.mock.calls[1][0].top).toBeLessThanOrEqual(0);
    caption.remove();
    await key('ArrowDown');
    expect(playing()).toEqual(['m-a']);
  });

  it('does not step past the last reel', async () => {
    const { playing, key } = await render(vi.fn(async () => []));
    await key('ArrowDown');
    expect(playing()).toEqual(['m-b']);
  });

  it('the X closes it', async () => {
    const { onClose } = await render();
    document.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_viewer_close()}"]`)!.click();
    await settle();
    expect(onClose).toHaveBeenCalled();
  });

  it('offers the save and the sound in the rail, whoever published the reel', async () => {
    await render();
    expect(
      document.querySelector('[data-reel-slide="b"] [data-reel-rail] [data-reel-save]')
    ).not.toBeNull();
    // (The rail's full order is `ReelViewer.rail.svelte.test.ts`'s.) Only the current reel mounts a player, drawn minimal.
    expect(document.querySelectorAll('[data-minimal-player]').length).toBe(1);
  });

  it('claims a drag only while the move is cancelable, and stands it down otherwise', async () => {
    const { playing } = await render();
    const frame = document.querySelector('[data-reel-viewer] .touch-none')!;
    const touch = (type: string, y: number, cancelable: boolean) => {
      const e = new Event(type, { bubbles: true, cancelable });
      const t = [{ clientX: 100, clientY: y }];
      Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : t });
      Object.defineProperty(e, 'changedTouches', { value: t });
      const prevent = vi.spyOn(e, 'preventDefault');
      frame.dispatchEvent(e);
      return prevent;
    };
    touch('touchstart', 400, true);
    // An uncancelable move belongs to the scroller: never prevented, so the engine logs nothing.
    expect(touch('touchmove', 200, false)).not.toHaveBeenCalled();
    touch('touchend', 100, true);
    await settle();
    // The stood-down drag did not page.
    expect(playing()).toEqual(['m-b']);

    touch('touchstart', 400, true);
    expect(touch('touchmove', 200, true)).toHaveBeenCalled();
  });

  it('shows each reel its age, the same relative time as a post header, and no deletion countdown', async () => {
    await render();
    const slide = document.querySelector('[data-reel-slide]')!;
    expect(slide.textContent).toContain(timeAgo('2026-10-01T00:00:00Z'));
    expect(slide.querySelector('[data-reel-expiry]')).toBeNull();
  });
});
