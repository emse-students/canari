// @vitest-environment happy-dom
/**
 * A CHANGE OF ORDER HANDS THE VIEWER A NEW LIST (`ReelsEntryButton`'s "Pour toi" / "Récents"): the
 * viewer starts over at the top of it, whatever reel the reader was on. Production, 1.6.10 (owner,
 * Firefox): the second swap, taken from the fourth reel, crashed the feed page on
 * `can't access property "kind", e is undefined`. The slide of the PRELOADED next reel was torn down
 * by the new list, its preload's cleanup read its `active` prop, that prop's `{@const role}` re-read
 * the slide's panes, and the slide's post was `reels[i]` - the NEW list read at the OLD index:
 * `undefined`, `fullScreenPageOf(undefined)`. Red on the viewer of 1.6.10 for the case whose new top
 * was the reel before the one on screen (a kept slide, so the old ones are torn down in the same
 * pass); every case stays here, since which one trips depends on the order Svelte tears slides down.
 *
 * The same swap from a FEED video's viewer (owner, 2026-11-11: the stream after a feed video follows
 * the reader's order, with the switch - `reels/reelStream.svelte.ts`) starts over with the OPENED
 * post first. And a throw inside the viewer closes the VIEWER, with a toast and an accusing line,
 * never the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';
import type { ReelPageLoader } from '$lib/reels/allReels';
import { m } from '$lib/paraglide/messages';
import { ReelStream } from '$lib/reels/reelStream.svelte';
import { settings } from '$lib/stores/settingsStore.svelte';

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
const toasts: string[] = [];
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (text: string) => void toasts.push(text),
}));
vi.mock('$lib/reels/fullScreenPost', async (orig) => {
  const real = await orig<typeof import('$lib/reels/fullScreenPost')>();
  return {
    ...real,
    fullScreenPageOf: (post: Parameters<typeof real.fullScreenPageOf>[0]) => {
      if ((post as { id?: string } | undefined)?.id === 'boom')
        throw new Error('a slide that cannot draw');
      return real.fullScreenPageOf(post);
    },
  };
});
/** What the server lists, by order: `ranked` (Pour toi) or not (Récents). */
const served: { ranked: PostEntity[]; recent: PostEntity[] } = { ranked: [], recent: [] };
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: async (o: { ranked?: boolean; offset?: number }) =>
    (o.offset ?? 0) > 0 ? [] : o.ranked ? served.ranked : served.recent,
}));
/** A fault planted in one of the viewer's OWN effects (the next-page read), outside its template. */
const faults = { nextPageEffect: false };
vi.mock('$lib/reels/reelViewerNav', async (orig) => {
  const real = await orig<typeof import('$lib/reels/reelViewerNav')>();
  return {
    ...real,
    shouldLoadMoreReels: (...a: Parameters<typeof real.shouldLoadMoreReels>) => {
      if (faults.nextPageEffect) throw new Error('the next-page decision threw');
      return real.shouldLoadMoreReels(...a);
    },
  };
});
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

function reel(id: string, landscape = false): PostEntity {
  return {
    id,
    kind: 'reel',
    markdown: `caption ${id}`,
    mentions: [],
    links: [],
    media: [
      {
        type: 'video',
        mediaId: `m-${id}`,
        key: 'k',
        iv: 'i',
        mimeType: 'video/mp4',
        size: 1,
        ...(landscape ? { width: 1280, height: 720 } : {}),
      },
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

/** A loader whose first page is `rows` (the opener already holds `rows[0]`), then nothing. */
function loaderOf(rows: PostEntity[]): ReelPageLoader {
  return async (offset) => (offset === 0 ? rows : []);
}

let host: Record<string, unknown> | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function key(k: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  await settle();
}

const onScreen = () =>
  document.querySelector('[data-post-media-stub]')?.getAttribute('data-post-media-stub');

beforeEach(() => {
  toasts.length = 0;
  preloads.length = 0;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
});

afterEach(() => {
  if (host) unmount(host);
  host = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ReelViewer - a change of order', () => {
  const recent = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'].map((id) => reel(id, id === 'r3'));
  const ranked = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'].map((id) => reel(id, id === 'k3'));

  for (const [label, secondStart] of [
    ['a reel that was not loaded', reel('fresh')],
    ['the reel preloaded after the one on screen', ranked[4]],
    ['the reel on screen', ranked[3]],
    ['the reel before the one on screen', ranked[2]],
  ] as const) {
    it(`starts over at the top of each new list, twice, from deep in the stream (new top: ${label})`, async () => {
      const props = $state({
        startPost: recent[0],
        loadPage: loaderOf(recent),
      });
      const target = document.createElement('div');
      document.body.appendChild(target);
      host = mount(ReelViewer, {
        target,
        props: {
          get startPost() {
            return props.startPost;
          },
          get loadPage() {
            return props.loadPage;
          },
          authToken: 'tok',
          onClose: () => {},
        },
      });
      await settle();
      expect(onScreen()).toBe('m-r0');
      await key('ArrowDown');
      await key('ArrowDown');
      expect(onScreen()).toBe('m-r2');

      // The first swap, from the third reel.
      props.startPost = ranked[0];
      props.loadPage = loaderOf(ranked);
      await settle();
      expect(onScreen()).toBe('m-k0');

      await key('ArrowDown');
      await key('ArrowDown');
      await key('ArrowDown');
      expect(onScreen()).toBe('m-k3');

      // The reel on screen settles (whole and playing), so the NEXT one preloads behind it - the
      // production reading: "its next reel had preloaded".
      const stub = document.querySelector('[data-post-media-stub]')!;
      stub.dispatchEvent(new Event('stubloaded'));
      stub.dispatchEvent(new Event('playing'));
      await settle();
      expect(preloads, 'the next reel preloads behind the settled one').toContain('m-k4');

      // The second swap, from the fourth reel, with the fifth preloading.
      props.startPost = secondStart;
      props.loadPage = loaderOf([secondStart, ...recent.filter((r) => r.id !== secondStart.id)]);
      await settle();
      expect(onScreen()).toBe(`m-${secondStart.id}`);
      expect(document.querySelectorAll('[data-reel-slide]').length).toBeGreaterThan(0);
    });
  }
});

describe('ReelViewer - a throw inside it', () => {
  it('closes the viewer with a toast and an accusing line, and never reaches the page', async () => {
    const onClose = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = document.createElement('div');
    document.body.appendChild(target);
    host = mount(ReelViewer, {
      target,
      props: {
        startPost: reel('boom'),
        loadPage: loaderOf([]),
        authToken: 'tok',
        onClose,
      },
    });
    await settle();
    expect(onClose, 'the viewer closes itself').toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([m.reels_viewer_crashed()]);
    expect(
      errors.mock.calls.some((c) =>
        String(c[0]).startsWith('[reel-viewer] the viewer failed in its content')
      )
    ).toBe(true);
    errors.mockRestore();
  });
});

describe('ReelViewer - a change of order from a feed video', () => {
  afterEach(() => settings.setReelsOrder('ranked'));

  it('starts over with the opened post first, in the new order, from deep in the stream', async () => {
    served.ranked = ['k0', 'k1', 'k2', 'k3', 'k4'].map((id) => reel(id, id === 'k3'));
    served.recent = ['r0', 'r1', 'r2'].map((id) => reel(id));
    const opened = reel('opened');
    const stream = new ReelStream();
    stream.open();
    const target = document.createElement('div');
    document.body.appendChild(target);
    host = mount(ReelViewer, {
      target,
      props: {
        startPost: opened,
        get loadPage() {
          return stream.loader;
        },
        get orderChoice() {
          return stream.choice;
        },
        authToken: 'tok',
        onClose: () => {},
      },
    });
    await settle();
    expect(onScreen()).toBe('m-opened');
    for (const expected of ['m-k0', 'm-k1', 'm-k2']) {
      await key('ArrowDown');
      expect(onScreen()).toBe(expected);
    }
    const stub = document.querySelector('[data-post-media-stub]')!;
    stub.dispatchEvent(new Event('stubloaded'));
    stub.dispatchEvent(new Event('playing'));
    await settle();

    const recentTab = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-reel-order] button'),
    ].find((b) => b.textContent?.trim() === m.reels_order_recent())!;
    recentTab.click();
    await settle();
    expect(stream.order).toBe('recent');
    expect(onScreen(), 'the opened post is first again').toBe('m-opened');
    await key('ArrowDown');
    expect(onScreen(), 'then the stream in the new order').toBe('m-r0');

    // Closing hands the closing viewer no new loader: no list is built only to be torn down.
    const debugs = vi.spyOn(console, 'debug');
    stream.close();
    await settle();
    expect(debugs.mock.calls.some((c) => String(c[0]).startsWith('[reel-viewer] a new list'))).toBe(
      false
    );
    expect(onScreen()).toBe('m-r0');
    debugs.mockRestore();
  });
});

describe('ReelViewer - a throw in one of its own effects', () => {
  afterEach(() => (faults.nextPageEffect = false));

  it('closes the viewer the same way, never reaching the page', async () => {
    faults.nextPageEffect = true;
    const onClose = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = document.createElement('div');
    document.body.appendChild(target);
    host = mount(ReelViewer, {
      target,
      props: { startPost: reel('a'), loadPage: loaderOf([]), authToken: 'tok', onClose },
    });
    await settle();
    expect(onClose, 'the viewer closes itself, once').toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([m.reels_viewer_crashed()]);
    expect(
      errors.mock.calls.some((c) =>
        String(c[0]).startsWith('[reel-viewer] the viewer failed in the next-page effect')
      )
    ).toBe(true);
    errors.mockRestore();
  });
});

describe('ReelViewer - a change of order during a track move', () => {
  it('lands that move on its own list at the swap, and warns about nothing', async () => {
    // Motion on: a step is a transition whose landing waits for `transitionend`.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const props = $state({
      startPost: reel('a0'),
      loadPage: loaderOf(['a0', 'a1', 'a2'].map((id) => reel(id))),
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    host = mount(ReelViewer, {
      target,
      props: {
        get startPost() {
          return props.startPost;
        },
        get loadPage() {
          return props.loadPage;
        },
        authToken: 'tok',
        onClose: () => {},
      },
    });
    await settle();
    // A screen of height: a step moves the track one screen, a real transition.
    Object.defineProperty(document.querySelector('[data-reel-card]')!, 'clientHeight', {
      value: 800,
    });
    const warns = vi.spyOn(console, 'warn');
    const debugs = vi.spyOn(console, 'debug');
    await key('ArrowDown');
    expect(onScreen(), 'the step is still in flight').toBe('m-a0');

    props.startPost = reel('b0');
    props.loadPage = loaderOf(['b0', 'b1'].map((id) => reel(id)));
    await settle();
    expect(debugs.mock.calls.map((c) => String(c[0]))).toContain(
      '[reel-viewer] the list changed during a track move - its landing runs now'
    );
    // The swap cancels the old transition: its end is not this list's, and nothing accuses it.
    const track = document.querySelector('[data-reel-track]')!;
    const cancel = new Event('transitioncancel') as Event & { propertyName: string };
    Object.defineProperty(cancel, 'propertyName', { value: 'transform' });
    track.dispatchEvent(cancel);
    await settle();
    expect(warns).not.toHaveBeenCalled();
    expect(onScreen()).toBe('m-b0');

    // The new list is at rest: the next step is free.
    await key('ArrowDown');
    const end = new Event('transitionend') as Event & { propertyName: string };
    Object.defineProperty(end, 'propertyName', { value: 'transform' });
    track.dispatchEvent(end);
    await settle();
    expect(onScreen()).toBe('m-b1');
    warns.mockRestore();
    debugs.mockRestore();
  });
});
