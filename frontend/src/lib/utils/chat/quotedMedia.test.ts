import { describe, expect, it } from 'vitest';
import { quotedIdOf, quotedVisualMedia } from './quotedMedia';
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
const held = (...rows: { id: string; content: string }[]) => new Map(rows.map((r) => [r.id, r]));

describe('quotedVisualMedia', () => {
  it('finds a quoted photo and its caption among the held messages', () => {
    expect(quotedVisualMedia(held(msg('a', ref(), 'hi')), 'a')).toEqual({
      ref: ref(),
      caption: 'hi',
    });
  });
  it('finds a video', () => {
    expect(quotedVisualMedia(held(msg('a', ref({ type: 'video' }))), 'a')?.ref.type).toBe('video');
  });
  it('is null when the original is not held, is text, a file or an unsent upload', () => {
    expect(quotedVisualMedia(held(), 'a')).toBeNull();
    expect(
      quotedVisualMedia(held({ id: 'a', content: serializeEnvelope(mkTextEnvelope('x')) }), 'a')
    ).toBeNull();
    expect(quotedVisualMedia(held(msg('a', ref({ type: 'file' }))), 'a')).toBeNull();
    expect(quotedVisualMedia(held(msg('a', ref({ mediaId: '' }))), 'a')).toBeNull();
  });
  it('is null for a CanaReel', () => {
    expect(
      quotedVisualMedia(held(msg('a', ref({ type: 'video', intent: 'reel-message' }))), 'a')
    ).toBeNull();
  });
  it('hands the SAME object for an unchanged original', () => {
    const rows = held(msg('a', ref(), 'hi'));
    expect(quotedVisualMedia(rows, 'a')).toBe(quotedVisualMedia(rows, 'a'));
  });
});

describe('quotedIdOf', () => {
  const body = serializeEnvelope(
    mkMediaEnvelope(ref(), undefined, { id: 'q1', senderId: 's', content: '' })
  );
  it('reads the reference a row read back from the store carries in its body', () => {
    expect(quotedIdOf({ content: body })).toBe('q1');
    expect(
      quotedIdOf({
        content: serializeEnvelope(mkTextEnvelope('x', { id: 'q2', senderId: 's', content: '' })),
      })
    ).toBe('q2');
  });
  it('prefers the in-memory reference, and is undefined for a row that answers nothing', () => {
    expect(quotedIdOf({ content: body, replyTo: { id: 'live' } })).toBe('live');
    expect(quotedIdOf({ content: serializeEnvelope(mkTextEnvelope('x')) })).toBeUndefined();
  });
});
