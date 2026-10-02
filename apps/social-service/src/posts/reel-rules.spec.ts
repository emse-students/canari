/**
 * What a create or edit request may say about a post's KIND.
 *
 * The server cannot look inside a reel's ciphertext, so these rules ARE the 90-second cap and the
 * "one video" shape: whatever is enforced is enforced here, as a refusal at the door. The cases that
 * carry weight are the boundaries (the cap itself, one past it) and the fields a reel must not
 * carry - a poll on something that expires in a month, a schedule that would start the month before
 * anybody could see it.
 */
import { BadRequestException } from '@nestjs/common';
import { assertCreateKindShape, assertReelEditShape } from './reel-rules';
import { REEL_MAX_DURATION_MS, isExpiredReel } from './reel.constants';

const video = { type: 'video', mimeType: 'video/mp4' };
const reel = (extra: Record<string, unknown> = {}) => ({
  kind: 'reel',
  durationMs: 41_250,
  markdown: '',
  media: [video],
  ...extra,
});

describe('assertCreateKindShape - a reel', () => {
  it('accepts one video, a declared duration and an empty caption', () => {
    expect(() => assertCreateKindShape(reel())).not.toThrow();
  });

  it('accepts the cap exactly and refuses one millisecond past it', () => {
    expect(() => assertCreateKindShape(reel({ durationMs: REEL_MAX_DURATION_MS }))).not.toThrow();
    expect(() => assertCreateKindShape(reel({ durationMs: REEL_MAX_DURATION_MS + 1 }))).toThrow(
      BadRequestException
    );
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1500.5],
    ['a string', '5000'],
    ['null', null],
  ])('refuses a duration that is %s', (_label, durationMs) => {
    expect(() => assertCreateKindShape(reel({ durationMs }))).toThrow(BadRequestException);
  });

  it.each([
    ['no media', { media: [] }],
    ['two videos', { media: [video, video] }],
    ['an image', { media: [{ type: 'image', mimeType: 'image/jpeg' }] }],
    ['a video typed as a file', { media: [{ type: 'file', mimeType: 'video/mp4' }] }],
    ['a video with an image MIME', { media: [{ type: 'video', mimeType: 'image/png' }] }],
    ['the legacy images list', { images: [video] }],
  ])('refuses %s', (_label, extra) => {
    expect(() => assertCreateKindShape(reel(extra))).toThrow(BadRequestException);
  });

  it.each([
    ['polls', { polls: [{ question: 'q' }] }],
    ['forms', { forms: [{ title: 't' }] }],
    ['attachedFormId', { attachedFormId: 'f' }],
    ['linkedCalendarEventId', { linkedCalendarEventId: 'e' }],
    ['scheduledAt', { scheduledAt: '2030-01-01T00:00:00Z' }],
  ])('refuses a reel carrying %s', (_label, extra) => {
    expect(() => assertCreateKindShape(reel(extra))).toThrow(BadRequestException);
  });

  it('treats an explicitly empty optional field as absent', () => {
    expect(() =>
      assertCreateKindShape(reel({ polls: [], forms: [], attachedFormId: null, scheduledAt: null }))
    ).not.toThrow();
  });
});

describe('assertCreateKindShape - a post keeps the rules it had', () => {
  it('leaves the text-or-media rule to the DTO, so a media-only post is not refused here', () => {
    expect(() => assertCreateKindShape({ markdown: '' })).not.toThrow();
    expect(() => assertCreateKindShape({ kind: 'post', markdown: '' })).not.toThrow();
  });

  it('accepts an ordinary post, with or without a kind', () => {
    expect(() => assertCreateKindShape({ markdown: 'hello' })).not.toThrow();
    expect(() => assertCreateKindShape({ kind: 'post', markdown: 'hello' })).not.toThrow();
  });

  it('refuses a durationMs on something that is not a reel: the two fields are one fact', () => {
    expect(() => assertCreateKindShape({ markdown: 'hello', durationMs: 5000 })).toThrow(
      BadRequestException
    );
  });
});

describe('assertReelEditShape - the caption is the only thing an edit may change', () => {
  it('accepts a payload that names nothing but the caption', () => {
    expect(() => assertReelEditShape({})).not.toThrow();
    expect(() => assertReelEditShape({ polls: [], attachedFormId: null })).not.toThrow();
  });

  it.each([
    ['media', { media: [video] }],
    ['images', { images: [video] }],
    ['polls', { polls: [{ question: 'q' }] }],
    ['attachedFormId', { attachedFormId: 'f' }],
    ['linkedCalendarEventId', { linkedCalendarEventId: 'e' }],
    ['scheduledAt', { scheduledAt: '2030-01-01T00:00:00Z' }],
  ])('refuses to change %s', (_label, body) => {
    expect(() => assertReelEditShape(body)).toThrow(BadRequestException);
  });
});

describe('isExpiredReel', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');

  it('is true for a reel at or past its expiry, false before it', () => {
    expect(isExpiredReel({ kind: 'reel', expiresAt: new Date(now - 1) }, now)).toBe(true);
    expect(isExpiredReel({ kind: 'reel', expiresAt: new Date(now) }, now)).toBe(true);
    expect(isExpiredReel({ kind: 'reel', expiresAt: new Date(now + 1) }, now)).toBe(false);
  });

  it('is never true for a post, whatever its columns say', () => {
    expect(isExpiredReel({ kind: 'post', expiresAt: new Date(0) }, now)).toBe(false);
    expect(isExpiredReel({ expiresAt: new Date(0) }, now)).toBe(false);
    expect(isExpiredReel({ kind: 'reel', expiresAt: null }, now)).toBe(false);
  });
});
