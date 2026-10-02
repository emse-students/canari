/**
 * THE ROW DOES NOT MOVE WHEN ITS MEDIA LANDS (user, 2026-10-02: "le LAYOUT SHIFTING c'est tres
 * mauvais").
 *
 * happy-dom lays nothing out, so this pins the CAUSE rather than a pixel: the box a medium occupies
 * is ONE element whose class and style are a function of the message alone. The skeleton, the
 * decrypted media and the failure are layers inside it - a test that sees the frame node replaced,
 * or its style change, between those states has found a shift. The pixels were measured in Chromium
 * and on the phones (docs/wiki/frontend/media-frame.md).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMediaRenderer from './MessageMediaRenderer.svelte';
import GifEmbed from './GifEmbed.svelte';
import type { MediaRef } from '$lib/media';
import type { MediaFailureCause } from '$lib/utils/mediaErrors';
import { resetMediaSizeCacheForTests } from '$lib/utils/mediaSizeCache';
import { withGifSize } from '$lib/utils/chat/messageDisplay';

const BLOB = 'blob:https://canari.emse.fr/9af53ef2-55f1-45a1-ae36-fcd0e84318d8';
const mounted: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  resetMediaSizeCacheForTests();
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const ref = (type: 'image' | 'video', size?: { width: number; height: number }): MediaRef => ({
  type,
  ...size,
  mediaId: `media-${type}`,
  key: '00'.repeat(32),
  iv: '00'.repeat(12),
  mimeType: type === 'image' ? 'image/webp' : 'video/mp4',
  size: 1024,
});

function frame(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-media-frame]');
  if (!el) throw new Error('no media frame rendered');
  return el;
}

/** The frame's geometry inputs - its class carries the width, its style the ratio and ceiling. */
const geometry = (el: HTMLElement) => ({
  style: el.getAttribute('style'),
  size: el.dataset.mediaSize,
  width: el.className.match(/\bw-\d+\b/)?.[0],
});

describe('MessageMediaRenderer - one frame from skeleton to media', () => {
  it.each([
    ['image', { width: 1080, height: 1920 }],
    ['video', { width: 720, height: 1280 }],
    ['image', undefined],
    ['video', undefined],
  ] as const)('a %s keeps its frame node and geometry (size %o)', (type, size) => {
    const props = $state<{
      mediaRef: MediaRef;
      blobUrl: string | null;
      failure: MediaFailureCause | null;
      textContent: string;
    }>({ mediaRef: ref(type, size), blobUrl: null, failure: null, textContent: '' });
    const instance = mount(MessageMediaRenderer, { target: document.body, props });
    mounted.push(() => unmount(instance));
    flushSync();

    const skeleton = frame();
    const before = geometry(skeleton);

    props.blobUrl = BLOB;
    flushSync();
    expect(frame()).toBe(skeleton);
    expect(geometry(frame())).toEqual(before);

    props.blobUrl = null;
    props.failure = 'other';
    flushSync();
    expect(frame()).toBe(skeleton);
    expect(geometry(frame())).toEqual(before);
  });

  it('a portrait video is reserved at its own ratio, not 16:9', () => {
    const instance = mount(MessageMediaRenderer, {
      target: document.body,
      props: {
        mediaRef: ref('video', { width: 720, height: 1280 }),
        blobUrl: null,
        failure: null,
        textContent: '',
      },
    });
    mounted.push(() => unmount(instance));
    flushSync();
    expect(frame().getAttribute('style')).toContain(`aspect-ratio: ${720 / 1280}`);
  });

  it('under a caption the skeleton has the width the media will have', () => {
    const props = $state<{
      mediaRef: MediaRef;
      blobUrl: string | null;
      failure: MediaFailureCause | null;
      textContent: string;
      bleed: boolean;
    }>({
      mediaRef: ref('image', { width: 800, height: 600 }),
      blobUrl: null,
      failure: null,
      textContent: 'legende',
      bleed: true,
    });
    const instance = mount(MessageMediaRenderer, { target: document.body, props });
    mounted.push(() => unmount(instance));
    flushSync();
    expect(geometry(frame()).width).toBe('w-68');
    props.blobUrl = BLOB;
    flushSync();
    expect(geometry(frame()).width).toBe('w-68');
  });
});

describe('GifEmbed - a GIF link holds its size before it loads', () => {
  const URL_BARE = 'https://static.klipy.com/ii/abc/def.gif';

  function mountGif(url: string): void {
    const instance = mount(GifEmbed, { target: document.body, props: { url } });
    mounted.push(() => unmount(instance));
    flushSync();
  }

  function loadImage(width: number, height: number): void {
    const img = frame().querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: width });
    Object.defineProperty(img, 'naturalHeight', { value: height });
    img.dispatchEvent(new Event('load'));
    flushSync();
  }

  // happy-dom drops a `width: min(...)` it cannot parse from the style it serialises, so the size
  // the frame was DRAWN FROM is read off `data-media-size`; `mediaFrame.test.ts` pins the style that
  // size produces.
  it('a sized link reserves its size, and loading changes nothing', () => {
    mountGif(withGifSize(URL_BARE, 498, 280));
    const before = { size: frame().dataset.mediaSize, style: frame().getAttribute('style') };
    expect(before.size).toBe('498x280');
    loadImage(498, 280);
    expect({ size: frame().dataset.mediaSize, style: frame().getAttribute('style') }).toEqual(
      before
    );
  });

  it('an old link shifts ONCE: the next mount opens at the measured size', () => {
    mountGif(URL_BARE);
    expect(frame().dataset.mediaSize).toBe('fallback');
    loadImage(320, 240);
    expect(frame().dataset.mediaSize).toBe('320x240');

    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    resetMediaSizeCacheForTests(); // a restart: read back from storage
    mountGif(URL_BARE);
    expect(frame().dataset.mediaSize).toBe('320x240');
  });

  it('a GIF that cannot load becomes its link', () => {
    mountGif(URL_BARE);
    frame().querySelector('img')!.dispatchEvent(new Event('error'));
    flushSync();
    expect(document.querySelector('[data-media-frame]')).toBeNull();
    expect(document.querySelector('a')?.getAttribute('href')).toBe(URL_BARE);
  });
});
