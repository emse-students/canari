// @vitest-environment happy-dom
/**
 * A picked video's composer thumbnail: its own first frame (a `<video>` seeked to `#t=0.1`), or, for
 * a take the in-app camera filmed, the picture the camera attached - a recorder's file has no seek
 * index, and its seeked `<video>` stayed a grey tile (Mi 9T, v1.2.9-alpha.1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PickedMediaPreview from './PickedMediaPreview.svelte';
import { attachCapturePoster } from '$lib/reels/capturePoster';

const mounted: Record<string, unknown>[] = [];

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function render(file: File) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(PickedMediaPreview, { target, props: { file, src: 'blob:file', alt: 'a' } }));
  flushSync();
  return target;
}

describe('PickedMediaPreview', () => {
  it('draws a filmed take by the picture the camera attached, not by a seek into the file', () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:poster', revokeObjectURL: () => {} })
    );
    const take = new File(['take'], 'canari-video-1.mkv', { type: 'video/x-matroska' });
    attachCapturePoster(take, new Blob(['jpg'], { type: 'image/jpeg' }));

    const target = render(take);

    expect(target.querySelector('video')).toBeNull();
    expect(target.querySelector('[data-picked-media-poster]')?.getAttribute('src')).toBe(
      'blob:poster'
    );
  });

  it('draws any other video by its own first frame', () => {
    const picked = new File(['clip'], 'clip.mp4', { type: 'video/mp4' });

    const target = render(picked);

    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:file#t=0.1');
    expect(target.querySelector('[data-picked-media-poster]')).toBeNull();
  });
});
