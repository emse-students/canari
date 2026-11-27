// @vitest-environment happy-dom
/**
 * A QUOTED PHOTO IS DRAWN SMALL AND DIMMED, NOT NAMED (owner, 2026-11-27). The thumbnail comes only
 * from what this device already holds - a decrypted blob in memory, else the sender's embedded
 * ThumbHash - and an original not held keeps today's text label without a warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const warm = vi.fn<(ref: unknown) => string | null>();
const release = vi.fn();
vi.mock('$lib/utils/mediaBlobCache', () => ({
  retainWarmDecryptedMediaBlobUrl: (ref: unknown) => warm(ref),
  releaseDecryptedMediaBlobUrl: (ref: unknown) => release(ref),
}));
vi.mock('$lib/utils/mediaPlaceholder', () => ({
  placeholderDataUrl: (p?: string) => (p ? 'data:image/png;base64,HASH' : null),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => 'Leon',
  resolveUserDisplayName: () => Promise.resolve('Leon'),
}));

import MessageReplyQuote from './MessageReplyQuote.svelte';
import type { MediaRef } from '$lib/media';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
beforeEach(() => {
  warm.mockReset();
  release.mockReset();
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

const photo: MediaRef = {
  type: 'image',
  mediaId: 'media-1234567890',
  key: 'k',
  iv: 'i',
  mimeType: 'image/jpeg',
  size: 10,
};

function render(quotedMedia: { ref: MediaRef; caption: string } | null) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageReplyQuote, {
    target,
    props: {
      content: m.chat_preview_photo(),
      isOwn: true,
      replierDisplayName: 'Jeanne',
      quotedMedia,
    },
  });
  flushSync();
  mounted.push(() => unmount(app, { outro: false }));
  return target;
}

describe('MessageReplyQuote - the quoted photo', () => {
  it('draws the decrypted photo held in memory, dimmed, with the kind as its accessible name', () => {
    warm.mockReturnValue('blob:held');
    const t = render({ ref: photo, caption: '' });
    const img = t.querySelector('img[data-testid="reply-media-thumb"]')!;
    expect(img.getAttribute('src')).toBe('blob:held');
    expect(img.getAttribute('aria-label')).toBe(m.chat_preview_photo());
    expect(img.className).toContain('opacity-60');
    expect(t.querySelector('button')!.textContent).not.toContain(m.chat_preview_photo());
  });

  it('draws a video as its first frame', () => {
    warm.mockReturnValue('blob:vid');
    const t = render({ ref: { ...photo, type: 'video', mimeType: 'video/mp4' }, caption: '' });
    const video = t.querySelector('video[data-testid="reply-media-thumb"]')!;
    expect(video.getAttribute('src')).toBe('blob:vid#t=0.1');
  });

  it('falls back to the embedded placeholder when nothing is held', () => {
    warm.mockReturnValue(null);
    const t = render({ ref: { ...photo, placeholder: 'abc' }, caption: '' });
    expect(t.querySelector('img[data-testid="reply-media-thumb"]')!.getAttribute('src')).toBe(
      'data:image/png;base64,HASH'
    );
  });

  it('keeps the text label when the original is not held at all', () => {
    warm.mockReturnValue(null);
    const t = render({ ref: photo, caption: '' });
    expect(t.querySelector('[data-testid="reply-media-thumb"]')).toBeNull();
    expect(t.querySelector('button')!.textContent).toContain(m.chat_preview_photo());
  });

  it('keeps the caption next to the thumbnail and releases the blob on teardown', () => {
    warm.mockReturnValue('blob:held');
    const t = render({ ref: photo, caption: 'coucou' });
    expect(t.querySelector('button')!.textContent).toContain('coucou');
    while (mounted.length) mounted.pop()?.();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
