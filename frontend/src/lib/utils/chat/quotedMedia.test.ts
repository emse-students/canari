import { describe, expect, it } from 'vitest';
import { quotedVisualMedia } from './quotedMedia';
import { serializeEnvelope, mkMediaEnvelope, mkTextEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

const ref = (over: Partial<MediaRef> = {}): MediaRef => ({
  type: 'image',
  mediaId: 'm1',
  key: 'k',
  iv: 'i',
  mimeType: 'image/jpeg',
  size: 1,
  ...over,
});
const msg = (id: string, r: MediaRef, caption?: string) => ({
  id,
  content: serializeEnvelope(mkMediaEnvelope(r, caption)),
});

describe('quotedVisualMedia', () => {
  it('finds a quoted photo and its caption among the held messages', () => {
    expect(quotedVisualMedia([msg('a', ref(), 'hi')], 'a')).toEqual({ ref: ref(), caption: 'hi' });
  });
  it('finds a video', () => {
    expect(quotedVisualMedia([msg('a', ref({ type: 'video' }))], 'a')?.ref.type).toBe('video');
  });
  it('is null when the original is not held, is text, a file or an unsent upload', () => {
    expect(quotedVisualMedia([], 'a')).toBeNull();
    expect(
      quotedVisualMedia([{ id: 'a', content: serializeEnvelope(mkTextEnvelope('x')) }], 'a')
    ).toBeNull();
    expect(quotedVisualMedia([msg('a', ref({ type: 'file' }))], 'a')).toBeNull();
    expect(quotedVisualMedia([msg('a', ref({ mediaId: '' }))], 'a')).toBeNull();
  });
  it('is null for a CanaReel', () => {
    expect(
      quotedVisualMedia([msg('a', ref({ type: 'video', intent: 'reel-message' }))], 'a')
    ).toBeNull();
  });
});
