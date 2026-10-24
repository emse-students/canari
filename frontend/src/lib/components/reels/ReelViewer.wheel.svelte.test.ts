// @vitest-environment happy-dom
/**
 * THE MOUSE WHEEL TURNS THE CANAREELS, ONE GESTURE ONE PAGE (user, 2026-10-19, desktop): a notch
 * down is the next reel, up the previous, through the arrow buttons' own step; a burst of events
 * (a trackpad flick, a free-spinning wheel) is one page until the wheel goes quiet; the comments
 * sheet, a scrolling child, ctrl+wheel and a horizontal scroll are left alone; the listener goes
 * with the viewer. Reduced motion lands every step at once; the quiet is a faked timer, so no
 * assertion reads a clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';
import { WHEEL_QUIET_MS } from '$lib/reels/reelWheel';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/reels/reelPreload', () => ({
  ReelPreload: class {
    stop() {}
  },
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  releaseHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

function reel(id: string): PostEntity {
  return {
    id,
    kind: 'reel',
    markdown: '',
    mentions: [],
    links: [],
    media: [
      { type: 'video', mediaId: `m-${id}`, key: 'k', iv: 'i', mimeType: 'video/mp4', size: 1 },
    ],
    images: [],
    polls: [],
    reactions: {},
    comments: [],
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(likerId?: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ReelViewer, {
    target,
    props: {
      startPost: reel('a'),
      authToken: 'tok',
      onClose: vi.fn(),
      loadPage: async () => [reel('b'), reel('c'), reel('d')],
      likerId,
    },
  });
  mounted.push(app);
  await settle();
  return app;
}

const playing = () =>
  [...document.querySelectorAll('[data-post-media-stub]')].map((e) =>
    e.getAttribute('data-post-media-stub')
  );

/** One wheel event over `on` (the playing reel by default); true when the viewer consumed it. */
async function wheel(init: WheelEventInit, on?: Element): Promise<boolean> {
  const target = on ?? document.querySelector('[data-post-media-stub]')!;
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  // jsdom's WheelEvent drops the modifier keys of its init; a browser's carries them.
  if (init.ctrlKey) Object.defineProperty(e, 'ctrlKey', { value: true });
  target.dispatchEvent(e);
  await settle();
  return e.defaultPrevented;
}

/** The wheel goes quiet: the gesture is over. */
async function quiet() {
  vi.advanceTimersByTime(WHEEL_QUIET_MS + 1);
  await settle();
}

it('one notch down is the next reel, one notch up the previous', async () => {
  await render();
  expect(await wheel({ deltaY: 100 })).toBe(true);
  expect(playing()).toEqual(['m-b']);
  await quiet();
  expect(await wheel({ deltaY: -100 })).toBe(true);
  expect(playing()).toEqual(['m-a']);
});

it('a burst of events is ONE page, and the next gesture after the quiet is the next page', async () => {
  await render();
  for (let i = 0; i < 12; i++) await wheel({ deltaY: 8 });
  expect(playing()).toEqual(['m-b']);
  await quiet();
  await wheel({ deltaY: 8 });
  expect(playing()).toEqual(['m-c']);
});

it('ctrl+wheel (zoom) and a horizontal scroll are left to the browser', async () => {
  await render();
  expect(await wheel({ deltaY: 100, ctrlKey: true })).toBe(false);
  expect(await wheel({ deltaX: 100, deltaY: 10 })).toBe(false);
  expect(playing()).toEqual(['m-a']);
});

it('over a child that scrolls (an unfolded caption), the child scrolls and the reel stays', async () => {
  await render();
  const caption = document.createElement('div');
  caption.setAttribute('data-reel-caption-open', '');
  document.querySelector('[data-reel-slide="a"]')!.appendChild(caption);
  expect(await wheel({ deltaY: 100 }, caption)).toBe(false);
  expect(playing()).toEqual(['m-a']);
});

it('with the comments sheet open, the wheel is the list scrolling, not the reel', async () => {
  await render('alice');
  document
    .querySelector('[data-reel-rail-comments]')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await settle();
  expect(document.querySelector('[data-comments-drawer-sheet]')).not.toBeNull();

  expect(await wheel({ deltaY: 100 })).toBe(false);
  expect(
    await wheel({ deltaY: 100 }, document.querySelector('[data-comments-drawer-sheet]')!)
  ).toBe(false);
  expect(playing()).toEqual(['m-a']);
});

it('the listener goes with the viewer', async () => {
  const removed = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
  const app = await render();
  unmount(mounted.pop()!);
  expect(app).toBeTruthy();
  expect(removed.mock.calls.some(([type]) => type === 'wheel')).toBe(true);
});

describe('with motion on (the page takes a transition to land)', () => {
  // jsdom lays nothing out: a screen of 0 px would make every move a no-op that lands at once.
  const realHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 800,
    });
  });
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', realHeight);
  });

  /** The track's transform transition ends, as the engine reports it. */
  async function land() {
    const track = document.querySelector('[data-reel-track]')!;
    const e = new Event('transitionend', { bubbles: true });
    Object.defineProperty(e, 'propertyName', { value: 'transform' });
    track.dispatchEvent(e);
    await settle();
  }

  const chevron = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  it('a chevron clicked while the wheel page lands neither drops that landing nor jams the wheel', async () => {
    await render();
    await wheel({ deltaY: 100 });
    chevron(m.reels_viewer_next()).click();
    await settle();
    await land();
    expect(playing()).toEqual(['m-b']);

    await quiet();
    expect(await wheel({ deltaY: 100 })).toBe(true);
    await land();
    expect(playing()).toEqual(['m-c']);
  });

  it('a cancelled track move (transitioncancel) still lands, so nothing stays frozen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await wheel({ deltaY: 100 });
    const track = document.querySelector('[data-reel-track]')!;
    const cancel = new Event('transitioncancel', { bubbles: true });
    Object.defineProperty(cancel, 'propertyName', { value: 'transform' });
    track.dispatchEvent(cancel);
    await settle();
    expect(playing()).toEqual(['m-b']);

    // The chevron answers again: `settling` was cleared.
    chevron(m.reels_viewer_next()).click();
    await settle();
    await land();
    expect(playing()).toEqual(['m-c']);
    warn.mockRestore();
  });

  it('a touchcancel while the wheel page lands neither drops that landing nor jams the wheel', async () => {
    await render();
    await wheel({ deltaY: 100 });
    document
      .querySelector('[data-reel-track]')!
      .parentElement!.dispatchEvent(new Event('touchcancel'));
    await settle();
    await land();
    expect(playing()).toEqual(['m-b']);

    await quiet();
    await wheel({ deltaY: 100 });
    await land();
    expect(playing()).toEqual(['m-c']);
  });
});
