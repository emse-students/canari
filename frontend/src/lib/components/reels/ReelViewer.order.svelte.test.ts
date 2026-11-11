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
 * And a throw inside the viewer closes the VIEWER, with a toast and an accusing line, never the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';
import type { ReelPageLoader } from '$lib/reels/allReels';
import { m } from '$lib/paraglide/messages';

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
      if ((post as { id?: string }).id === 'boom') throw new Error('a slide that cannot draw');
      return real.fullScreenPageOf(post);
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
        String(c[0]).startsWith('[reel-viewer] the viewer failed on boom')
      )
    ).toBe(true);
    errors.mockRestore();
  });
});
