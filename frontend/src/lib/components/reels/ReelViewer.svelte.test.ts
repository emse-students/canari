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
const ownReels = new Map<string, unknown>();
vi.mock('$lib/reels/myReels.svelte', () => ({
  myReels: {
    find: (id: string) => ownReels.get(id),
    ensure: () => {},
    daysLeft: () => 12,
  },
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
  return { onClose, loadPage, playing, key };
}

beforeEach(() => {
  ownReels.clear();
  preloads.length = 0;
  stopped.length = 0;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ReelViewer', () => {
  it('plays the touched reel first, alone, and preloads the next', async () => {
    const { playing, loadPage } = await render();
    expect(loadPage).toHaveBeenCalledWith(0, 10);
    // b first, then a and c from the page (b not repeated); only b has a player.
    expect(playing()).toEqual(['m-b']);
    expect(preloads).toEqual(['m-a']);
    expect(document.querySelectorAll('[data-reel-slide]').length).toBe(2);
  });

  it('steps down to the next reel and back up', async () => {
    const { playing, key } = await render();
    await key('ArrowDown');
    expect(playing()).toEqual(['m-a']);
    expect(stopped).toContain('m-a');
    expect(preloads).toContain('m-c');
    await key('ArrowUp');
    expect(playing()).toEqual(['m-b']);
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

  it("offers the save on the author's own reel only", async () => {
    ownReels.set('b', { id: 'b', expiresAt: '', expiringSoon: true, media: [] });
    await render();
    expect(document.querySelectorAll('[data-reel-save]').length).toBe(1);
    expect(document.querySelector('[data-reel-slide="b"] [data-reel-save]')).not.toBeNull();
  });
});
