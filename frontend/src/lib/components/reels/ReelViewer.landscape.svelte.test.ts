// @vitest-environment happy-dom
/**
 * THE PAGER TURNS OVER A LANDSCAPE VIDEO ONLY (owner, 2026-11-12, issue #3407; screen-orientation.md):
 * `auto` is requested while the item on show is a video whose own shape is landscape, with the rotate
 * button; a vertical video, a photo and a media of unknown size request nothing; a swipe between two
 * landscape videos keeps ONE request; a swipe to a portrait one, and closing, release it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const runtime = vi.hoisted(() => ({ android: true }));
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => runtime.android,
  isIosTauriRuntime: () => false,
}));
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

import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';
import { resetScreenOrientationForTest } from '$lib/mobile/screenOrientation.svelte';

type Win = Window & { canariOrientation?: { set: (m: string) => void } };

function item(id: string, kind: 'video' | 'image', width?: number, height?: number): PostEntity {
  return {
    id,
    kind: 'reel',
    markdown: `caption ${id}`,
    mentions: [],
    links: [],
    media: [
      {
        type: kind,
        mediaId: `m-${id}`,
        key: 'k',
        iv: 'i',
        mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
        size: 1,
        width,
        height,
      },
    ],
    images: [],
    polls: [],
    authorFirstName: 'Ada',
    authorLastName: 'L',
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  } as PostEntity;
}
const LAND_A = item('la', 'video', 1920, 1080);
const LAND_B = item('lb', 'video', 1280, 720);
const PORTRAIT = item('p', 'video', 720, 1280);
const SQUARE = item('sq', 'video', 1000, 1000);
const PHOTO = item('ph', 'image', 1920, 1080);
const UNKNOWN = item('un', 'video');

const mounted: Record<string, unknown>[] = [];
let sent: string[];

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(start: PostEntity, rest: PostEntity[] = []) {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(ReelViewer, {
    target,
    props: { startPost: start, authToken: 'tok', onClose, loadPage: vi.fn(async () => rest) },
  });
  mounted.push(instance);
  await settle();
  const next = async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await settle();
  };
  return { next, close: () => unmount(mounted.pop()!) };
}

const rotateButton = () => document.querySelector('[data-rotate-button]');

beforeEach(() => {
  resetScreenOrientationForTest();
  runtime.android = true;
  sent = [];
  (window as Win).canariOrientation = { set: (m) => sent.push(m) };
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  delete (window as Win).canariOrientation;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the reel pager turns over a landscape video only', () => {
  it('requests auto for a landscape video and draws the rotate button', async () => {
    await render(LAND_A);
    expect(sent).toEqual(['auto']);
    expect(rotateButton()).not.toBeNull();
  });

  it('requests nothing for a vertical video, a square one, a photo or an unmeasured one', async () => {
    for (const post of [PORTRAIT, SQUARE, PHOTO, UNKNOWN]) {
      const { close } = await render(post);
      expect(sent, post.id).toEqual([]);
      expect(rotateButton(), post.id).toBeNull();
      close();
    }
  });

  it('keeps ONE request across a swipe from a landscape video to another', async () => {
    const { next } = await render(LAND_A, [LAND_B]);
    await next();
    expect(sent).toEqual(['auto']);
    expect(rotateButton()).not.toBeNull();
  });

  it('releases when the next item is vertical, and asks again for a later landscape one', async () => {
    const { next } = await render(LAND_A, [PORTRAIT, LAND_B]);
    await next();
    expect(sent).toEqual(['auto', 'portrait']);
    expect(rotateButton()).toBeNull();
    await next();
    expect(sent).toEqual(['auto', 'portrait', 'auto']);
  });

  it('releases when the viewer closes', async () => {
    const { close } = await render(LAND_A);
    close();
    expect(sent).toEqual(['auto', 'portrait']);
  });

  it('forces landscape from the rotate button', async () => {
    await render(LAND_A);
    (rotateButton() as HTMLButtonElement).click();
    flushSync();
    expect(sent).toEqual(['auto', 'landscape']);
  });

  it('draws no rotate button where the build cannot force (the web)', async () => {
    runtime.android = false;
    await render(LAND_A);
    expect(rotateButton()).toBeNull();
  });
});
