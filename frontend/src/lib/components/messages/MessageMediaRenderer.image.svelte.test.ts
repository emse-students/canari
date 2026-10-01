/**
 * EVERY PHOTO IN A CONVERSATION WAS HANDED TO A `<video>` (#1229, shipped in `v0.18.32`).
 *
 * The change that made a feed video play inline replaced the IMAGE branch of this renderer instead
 * of a video one, so a decrypted JPEG or PNG went to `InlineVideo` - Firefox: *"HTTP Content-Type
 * of image/jpeg is not supported. Load of media resource blob:...#t=0.1 failed"*, and nothing on
 * screen. No test had ever mounted this branch: the caption test passes `blobUrl: null`, which
 * stops at the skeleton. These mount it with the bytes decrypted, as `MessageBubble` does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMediaRenderer from './MessageMediaRenderer.svelte';
import type { MediaRef } from '$lib/media';

const BLOB = 'blob:https://canari.emse.fr/9af53ef2-55f1-45a1-ae36-fcd0e84318d8';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(mediaRef: MediaRef, extra: Record<string, unknown> = {}): void {
  const instance = mount(MessageMediaRenderer, {
    target: document.body,
    props: {
      mediaRef,
      blobUrl: BLOB,
      failure: null,
      textContent: '',
      ...extra,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
}

const media = (
  type: MediaRef['type'],
  mimeType: string,
  size?: { width: number; height: number }
): MediaRef => ({
  type,
  ...size,
  mediaId: 'media-1',
  key: '00'.repeat(32),
  iv: '00'.repeat(12),
  mimeType,
  size: 1024,
  fileName: `file.${mimeType.split('/')[1]}`,
});

describe('MessageMediaRenderer - a decrypted photo', () => {
  it.each(['image/jpeg', 'image/png'])('draws a %s as an image, never as a video', (mime) => {
    render(media('image', mime));
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe(BLOB);
    expect(document.querySelector('video')).toBeNull();
  });

  it('opens the viewer on a tap', () => {
    render(media('image', 'image/jpeg'));
    const open = document.querySelector<HTMLButtonElement>('button:has(> img)');
    expect(open).not.toBeNull();
    open!.click();
    flushSync();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('still draws a video as a video - the feed one, with no native controls', () => {
    render(media('video', 'video/mp4'));
    const video = document.querySelector('video');
    // `InlineVideo` seeks a decrypted file to its first frame (`#t=0.1`), as in the feed.
    expect(video?.getAttribute('src')).toBe(`${BLOB}#t=0.1`);
    expect(video?.hasAttribute('controls')).toBe(false);
  });

  /**
   * A VIDEO KEEPS ITS OWN SHAPE (user, 2026-10-02: the conversation cut it down to 16:9 and the
   * rest was one tap away). The box reserves the clip's real aspect ratio and the video is
   * contained in it - `object-cover` is what cropped it.
   */
  it('reserves a portrait clip at its own shape and contains it, never crops it', () => {
    render(media('video', 'video/mp4', { width: 720, height: 1280 }));
    const video = document.querySelector('video')!;
    const box = video.closest<HTMLElement>('[style*="aspect-ratio"]')!;
    expect(Number.parseFloat(box.style.aspectRatio)).toBeCloseTo(720 / 1280, 3);
    expect(video.className).toContain('object-contain');
    expect(video.className).not.toContain('object-cover');
  });

  it('reserves a landscape clip at its own shape too', () => {
    render(media('video', 'video/mp4', { width: 1920, height: 1080 }));
    const box = document.querySelector('video')!.closest<HTMLElement>('[style*="aspect-ratio"]')!;
    expect(Number.parseFloat(box.style.aspectRatio)).toBeCloseTo(1920 / 1080, 3);
  });
});

/**
 * A PHOTO OR VIDEO WITH TEXT FILLS THE TOP OF ITS BUBBLE (user, 2026-10-02: "l'image est au dessus
 * de la bulle, comme si elle etait envoyee seule avant le texte, pas dans la bulle"). It sat as a
 * framed thumbnail inside the bubble's padding. `bleed` cancels that padding and the media's own
 * rounding - the bubble clips the corners - and the caption stays in the same bubble under it.
 */
describe('MessageMediaRenderer - media that bleeds into its bubble', () => {
  const caption = {
    textContent: 'Regarde cette vue',
    textSegments: [{ type: 'text' as const, value: 'Regarde cette vue' }],
  };

  it('cancels the bubble padding and its own rounding, and keeps the caption beneath', () => {
    render(media('image', 'image/jpeg'), { ...caption, bleed: true });
    const img = document.querySelector('img')!;
    const frame = img.closest('button')!;
    expect(frame.className).not.toContain('rounded-3xl');
    expect(frame.parentElement!.parentElement!.className).toContain('-mx-3');
    const text = document.querySelector('p')!;
    expect(text.textContent).toContain('Regarde cette vue');
    expect(img.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a video bleeds the same way', () => {
    render(media('video', 'video/mp4', { width: 720, height: 1280 }), { ...caption, bleed: true });
    const box = document.querySelector('video')!.closest<HTMLElement>('[style*="aspect-ratio"]')!;
    expect(box.className).not.toContain('rounded-3xl');
  });

  it('keeps its framed, rounded look when it carries no caption', () => {
    render(media('image', 'image/jpeg'));
    expect(document.querySelector('img')!.closest('button')!.className).toContain('rounded-3xl');
  });
});
