// @vitest-environment happy-dom
/**
 * A post of several pictures and videos in the reel viewer (owner, 2026-11-06, as on Instagram):
 * left and right step its media, up and down still step the posts, the visible media is kept per
 * post, only the visible video plays, its neighbours and the next post's opening media are fetched
 * once it has settled, and the rail's save follows the visible media. The media layer is replaced
 * (`PostMedia`, `ReelPreload`); reduced motion makes every step land at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity, PostMediaRef } from '$lib/posts/api';

const preloads: string[] = [];
vi.mock('$lib/reels/reelPreload', () => ({
  worthPreloading: () => true,
  ReelPreload: class {
    constructor(ref: { mediaId: string }) {
      preloads.push(ref.mediaId);
    }
    stop() {}
  },
}));
vi.mock('$lib/actions/playWhileVisible', () => ({ holdPlayback: () => () => {} }));
vi.mock('$lib/reels/reelPosters.svelte', () => ({
  reelPosterUrl: () => null,
  captureReelPoster: vi.fn(async () => {}),
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

const ref = (type: 'image' | 'video', mediaId: string): PostMediaRef =>
  ({
    type,
    mediaId,
    key: 'k',
    iv: 'i',
    mimeType: type === 'image' ? 'image/webp' : 'video/mp4',
    size: 1,
  }) as PostMediaRef;

function post(id: string, kind: 'post' | 'reel', media: PostMediaRef[]): PostEntity {
  return {
    id,
    kind,
    markdown: `caption ${id}`,
    mentions: [],
    links: [],
    media,
    images: [],
    polls: [],
    authorFirstName: 'Ada',
    authorLastName: 'L',
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const carousel = post('car', 'post', [ref('image', 'p1'), ref('video', 'v2'), ref('image', 'p3')]);
const nextReel = post('next', 'reel', [ref('video', 'm-next')]);

const mounted: Record<string, unknown>[] = [];

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(startMediaIndex?: number) {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelViewer, {
      target,
      props: {
        startPost: carousel,
        authToken: 'tok',
        onClose,
        loadPage: vi.fn(async () => [carousel, nextReel]),
        ...(startMediaIndex !== undefined ? { startMediaIndex } : {}),
      },
    })
  );
  await settle();
  const frame = document.querySelector('[data-reel-viewer] .touch-none')!;
  /** The media drawn in full (a picture mounted, a video's player), in DOM order. */
  const drawn = () =>
    [...document.querySelectorAll('[data-post-media-stub]')].map((e) =>
      e.getAttribute('data-post-media-stub')
    );
  const players = () =>
    [...document.querySelectorAll('[data-post-media-stub][data-minimal-player]')].map((e) =>
      e.getAttribute('data-post-media-stub')
    );
  const current = () =>
    [...document.querySelectorAll('[data-reel-carousel-dot]')].findIndex(
      (d) => d.getAttribute('data-reel-carousel-dot') === 'current'
    );
  const swipe = async (dx: number, dy: number) => {
    const fire = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      const t = [{ clientX: x, clientY: y }];
      Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : t });
      Object.defineProperty(e, 'changedTouches', { value: t });
      frame.dispatchEvent(e);
    };
    fire('touchstart', 200, 400);
    fire('touchmove', 200 + dx / 2, 400 + dy / 2);
    fire('touchmove', 200 + dx, 400 + dy);
    fire('touchend', 200 + dx, 400 + dy);
    await settle();
  };
  const key = async (k: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    await settle();
  };
  /** The visible media reports itself whole (and playing): what lets its neighbours fetch. */
  const settleVisible = async () => {
    const stub = document.querySelector('[data-reel-media-active] [data-post-media-stub]')!;
    stub.dispatchEvent(new Event('stubloaded'));
    stub.dispatchEvent(new Event('playing'));
    await settle();
  };
  return { onClose, frame, drawn, players, current, swipe, key, settleVisible };
}

beforeEach(() => {
  preloads.length = 0;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
  // The frame has no layout in happy-dom: a width makes the commit ratio meaningful.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a carousel page in the reel viewer', () => {
  it('opens on its first media, with one dot per media, the first lit and named', async () => {
    const { current, drawn } = await render();
    expect(document.querySelector('[data-reel-page="carousel"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-reel-carousel-dot]')).toHaveLength(3);
    expect(current()).toBe(0);
    expect(document.querySelector('[data-reel-carousel-dots]')?.getAttribute('aria-label')).toBe(
      '1 sur 3'
    );
    // Only the visible picture is fetched until it settles: nothing competes with it.
    expect(drawn()).toEqual(['p1']);
    expect(preloads).toEqual([]);
  });

  /** A tap on a grid's video in the feed opens full screen on THAT video (owner, 2026-11-10). */
  it('opens on the media it was asked for, the tapped video playing', async () => {
    const { current, players } = await render(1);
    expect(current()).toBe(1);
    expect(players()).toEqual(['v2']);
  });

  it('a swipe left shows the next media, and only the VISIBLE video has a player', async () => {
    const { current, players, swipe } = await render();
    await swipe(-200, 10);
    expect(current()).toBe(1);
    expect(players()).toEqual(['v2']);
    await swipe(-200, 0);
    expect(current()).toBe(2);
    // The video left the screen: its player unmounted, so it no longer plays.
    expect(players()).toEqual([]);
  });

  it('a swipe right steps back, and on the first media it springs back, never closing', async () => {
    const { current, swipe, onClose } = await render();
    await swipe(-200, 0);
    await swipe(200, 0);
    expect(current()).toBe(0);
    await swipe(200, 0);
    expect(current()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a mostly vertical drag pages the POST, never the media', async () => {
    const { current, swipe, players } = await render();
    await swipe(-60, -400);
    expect(players()).toEqual(['m-next']);
    await swipe(0, 400);
    expect(current()).toBe(0);
  });

  it('keeps the visible media per post: scrolled away and back, the post opens where it was left', async () => {
    const { current, swipe, players } = await render();
    await swipe(-200, 0);
    await swipe(0, -400);
    await swipe(0, 400);
    expect(current()).toBe(1);
    expect(players()).toEqual(['v2']);
  });

  it('once the visible media has settled, its neighbours and the next post are fetched', async () => {
    const { swipe, drawn, settleVisible } = await render();
    await swipe(-200, 0);
    expect(preloads).toEqual([]);
    await settleVisible();
    // The neighbour pictures mount; the next post's opening video is fetched ahead.
    expect(drawn()).toEqual(expect.arrayContaining(['p1', 'v2', 'p3']));
    expect(preloads).toEqual(['m-next']);
  });

  it("a media swipe in a settled page keeps the next post's preload going", async () => {
    const { current, swipe, settleVisible } = await render();
    await settleVisible();
    expect(preloads.filter((id) => id === 'm-next')).toEqual(['m-next']);
    await swipe(-200, 0);
    await swipe(-200, 0);
    // Not aborted and restarted: still the one fetch.
    expect(preloads.filter((id) => id === 'm-next')).toEqual(['m-next']);
    expect(current()).toBe(2);
  });

  it('the next media of a settled picture is fetched ahead when it is a video', async () => {
    const { settleVisible } = await render();
    await settleVisible();
    expect(preloads).toEqual(expect.arrayContaining(['v2', 'm-next']));
  });

  it('the arrow keys and the buttons step the media; off a carousel the keys are free', async () => {
    const { current, key } = await render();
    await key('ArrowRight');
    expect(current()).toBe(1);
    await key('ArrowLeft');
    expect(current()).toBe(0);
    (document.querySelector('[data-reel-carousel-next]') as HTMLButtonElement).click();
    await settle();
    expect(current()).toBe(1);
    (document.querySelector('[data-reel-carousel-prev]') as HTMLButtonElement).click();
    await settle();
    expect(current()).toBe(0);
    expect(document.querySelector('[data-reel-carousel-prev]')).toBeNull();
  });

  it('a mouse drag steps the media, and the click it ends with is not a tap', async () => {
    const { current, frame } = await render();
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: 400,
      });
    frame.dispatchEvent(pointer('pointerdown', 300));
    window.dispatchEvent(pointer('pointermove', 200));
    window.dispatchEvent(pointer('pointermove', 100));
    window.dispatchEvent(pointer('pointerup', 100));
    // The browser dispatches the click in the same task as the pointerup. The document's link
    // handler (capture) must never see it live, or a drag ending on a caption's link would open
    // it: the window's capture stops it before the document.
    let seenByDocument: boolean | null = null;
    const documentHandler = (e: Event) => (seenByDocument = e.defaultPrevented);
    document.addEventListener('click', documentHandler, true);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    document.querySelector('[data-reel-slide] [data-reel-caption]')!.dispatchEvent(click);
    document.removeEventListener('click', documentHandler, true);
    expect(click.defaultPrevented).toBe(true);
    expect(seenByDocument).toBeNull();
    await settle();
    expect(current()).toBe(1);
    // The next click is a tap again.
    const next = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    document.querySelector('[data-reel-slide]')!.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
  });

  it('a mouse drag whose pointerup was lost (a context menu) is cancelled on the next move', async () => {
    const { current, frame } = await render();
    const pointer = (type: string, x: number, buttons: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        button: 0,
        buttons,
        clientX: x,
        clientY: 400,
      });
    frame.dispatchEvent(pointer('pointerdown', 300, 1));
    window.dispatchEvent(pointer('pointermove', 100, 1));
    // The button came up elsewhere: the next move carries no button.
    window.dispatchEvent(pointer('pointermove', 50, 0));
    window.dispatchEvent(pointer('pointerup', 50, 0));
    await settle();
    expect(current()).toBe(0);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    document.querySelector('[data-reel-slide]')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('a drag that makes no click does not swallow the next real tap', async () => {
    const { frame } = await render();
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: 400,
      });
    frame.dispatchEvent(pointer('pointerdown', 300));
    window.dispatchEvent(pointer('pointermove', 100));
    window.dispatchEvent(pointer('pointerup', 100));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    document.querySelector('[data-reel-slide]')!.dispatchEvent(tap);
    expect(tap.defaultPrevented).toBe(false);
  });

  it("the rail's save follows the visible media: none on a picture, the video's on a video", async () => {
    const { key } = await render();
    const save = () => document.querySelector('[data-reel-slide="car"] [data-reel-save]');
    expect(save()).toBeNull();
    await key('ArrowRight');
    expect(save()).not.toBeNull();
  });
});
