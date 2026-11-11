// @vitest-environment happy-dom
/**
 * A SLIDE'S OWN FULL-SCREEN VIEWER HAS THE KEYBOARD (landscape chip, owner 2026-11-11): while it is
 * open over the pager the window handlers of `ReelViewer` stand down, so Escape is the viewer's
 * alone (it must not close the whole reel viewer) and the arrows do not page the reels behind it.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';

vi.mock('$lib/reels/reelPreload', () => ({
  worthPreloading: () => true,
  ReelPreload: class {
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

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function render() {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelViewer, {
      target,
      props: {
        startPost: reel('b'),
        authToken: 'tok',
        onClose,
        loadPage: vi.fn(async () => [reel('a'), reel('b'), reel('c')]),
      },
    })
  );
  await settle();
  const shown = () =>
    document.querySelector('[data-post-media-stub]')!.getAttribute('data-post-media-stub');
  const key = async (k: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true }));
    await settle();
  };
  const viewer = async (open: boolean) => {
    document
      .querySelector('[data-post-media-stub]')!
      .dispatchEvent(new CustomEvent('stubviewer', { detail: open }));
    await settle();
  };
  return { onClose, shown, key, viewer };
}

it('leaves Escape and the arrows to a slide viewer while it is open, then takes them back', async () => {
  const { onClose, shown, key, viewer } = await render();
  expect(shown()).toBe('m-b');

  await viewer(true);
  await key('Escape');
  expect(onClose, 'Escape closes the slide viewer only, never the pager').not.toHaveBeenCalled();
  await key('ArrowDown');
  await key('PageDown');
  await key('ArrowUp');
  expect(shown(), 'the arrows do not page the reels behind the viewer').toBe('m-b');

  await viewer(false);
  await key('ArrowDown');
  expect(shown(), 'closed, the pager has its keys again').toBe('m-a');
  await key('Escape');
  expect(onClose).toHaveBeenCalledTimes(1);
});
