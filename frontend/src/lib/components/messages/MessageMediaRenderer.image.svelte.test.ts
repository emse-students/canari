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

function render(mediaRef: MediaRef): void {
  const instance = mount(MessageMediaRenderer, {
    target: document.body,
    props: {
      mediaRef,
      blobUrl: BLOB,
      failure: null,
      textContent: '',
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
}

const media = (type: MediaRef['type'], mimeType: string): MediaRef => ({
  type,
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

  it('still draws a video as a video', () => {
    render(media('video', 'video/mp4'));
    expect(document.querySelector('video')?.getAttribute('src')).toBe(BLOB);
  });
});
