// @vitest-environment happy-dom
/**
 * THE QUOTE FOLLOWS ITS ORIGINAL: when the original joins the thread (or its ref changes) after the
 * quote mounted, the thumbnail is taken then, and the old hold is released.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const warm = vi.fn<(ref: { mediaId: string }) => string | null>();
const release = vi.fn();
vi.mock('$lib/utils/mediaBlobCache', () => ({
  onDecryptedMediaHeld: () => () => {},
  retainWarmDecryptedMediaBlobUrl: (ref: { mediaId: string }) => warm(ref),
  releaseDecryptedMediaBlobUrl: (ref: unknown) => release(ref),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => 'Leon',
  resolveUserDisplayName: () => Promise.resolve('Leon'),
}));

import MessageReplyQuote from './MessageReplyQuote.svelte';
import type { MediaRef } from '$lib/media';
import type { QuotedVisual } from '$lib/utils/chat/quotedMedia';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  warm.mockReset();
  release.mockReset();
});

const ref = (mediaId: string): MediaRef => ({
  type: 'image',
  mediaId,
  key: 'k',
  iv: 'i',
  mimeType: 'image/jpeg',
  size: 1,
});

describe('MessageReplyQuote - an original that arrives after the quote', () => {
  it('takes the blob when the original joins, and follows a ref change', () => {
    warm.mockImplementation((r) => `blob:${r.mediaId}`);
    const props = $state<{ quotedMedia: QuotedVisual | null }>({ quotedMedia: null });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(MessageReplyQuote, {
      target,
      props: Object.assign(props, { content: 'Photo', isOwn: true, replierDisplayName: 'J' }),
    });
    mounted.push(() => unmount(app, { outro: false }));
    flushSync();
    expect(target.querySelector('[data-testid="reply-media-thumb"]')).toBeNull();
    expect(warm).not.toHaveBeenCalled();

    props.quotedMedia = { ref: ref('one'), caption: '' };
    flushSync();
    expect(target.querySelector('img')!.getAttribute('src')).toBe('blob:one');

    props.quotedMedia = { ref: ref('two'), caption: '' };
    flushSync();
    expect(target.querySelector('img')!.getAttribute('src')).toBe('blob:two');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toMatchObject({ mediaId: 'one' });
  });
});
