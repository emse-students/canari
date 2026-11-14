import { describe, it, expect } from 'vitest';
import { buildViewerSequence, viewerBounds, viewerItemKey } from './viewerSequence';
import type { SharedMediaItem } from './sharedContent';
import type { MediaRef } from '$lib/media';

const NOW = 1_000_000;

function item(
  id: string,
  timestamp: number,
  media: Partial<MediaRef> = {},
  purgedAt?: number
): SharedMediaItem {
  return {
    messageId: id,
    senderId: 'u',
    timestamp,
    media: { mediaId: `m-${id}`, type: 'image', ...media } as MediaRef,
    ...(purgedAt ? { purgedAt } : {}),
  };
}

describe('buildViewerSequence', () => {
  it('reads oldest first, whatever order the aggregate comes in (it is newest first)', () => {
    const seq = buildViewerSequence([item('c', 30), item('a', 10), item('b', 20)], NOW);
    expect(seq.map((i) => i.messageId)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a timestamp tie on the message id, so the order is reproducible', () => {
    const seq = buildViewerSequence([item('b', 10), item('a', 10)], NOW);
    expect(seq.map((i) => i.messageId)).toEqual(['a', 'b']);
  });

  it('keeps images and videos and drops every other kind', () => {
    const seq = buildViewerSequence(
      [item('a', 1), item('b', 2, { type: 'video' }), item('c', 3, { type: 'file' })],
      NOW
    );
    expect(seq.map((i) => i.messageId)).toEqual(['a', 'b']);
  });

  it('gives two attachments of one message two distinct keys, both kept', () => {
    const one = item('a', 1);
    const two = { ...item('a', 1), media: { ...one.media, mediaId: 'other' } };
    const seq = buildViewerSequence([one, two], NOW);
    expect(seq).toHaveLength(2);
    expect(new Set(seq.map(viewerItemKey)).size).toBe(2);
  });

  it('skips a CanaReel sent in the chat, an expired media and a purged one', () => {
    const seq = buildViewerSequence(
      [
        item('ok', 1),
        item('reel', 2, { type: 'video', intent: 'reel-message' }),
        item('old', 3, { type: 'video', expiresAtMs: NOW - 1 }),
        item('later', 4, { expiresAtMs: NOW + 1 }),
        item('gone', 5, {}, 99),
      ],
      NOW
    );
    expect(seq.map((i) => i.messageId)).toEqual(['ok', 'later']);
  });
});

describe('viewerBounds', () => {
  it('stops at both ends: no wrap-around', () => {
    expect(viewerBounds(3, 0)).toEqual({ showPrev: false, showNext: true });
    expect(viewerBounds(3, 1)).toEqual({ showPrev: true, showNext: true });
    expect(viewerBounds(3, 2)).toEqual({ showPrev: true, showNext: false });
  });

  it('offers nothing for a single item or an unknown one', () => {
    expect(viewerBounds(1, 0)).toEqual({ showPrev: false, showNext: false });
    expect(viewerBounds(3, -1)).toEqual({ showPrev: false, showNext: false });
  });
});
