/**
 * What a create or edit request may say about a post's KIND.
 *
 * The server cannot look inside a reel's ciphertext, so these rules ARE the vertical-or-short rule and
 * the "one video" shape: whatever is enforced is enforced here, as a refusal at the door. The cases that
 * carry weight are the boundaries (the cap itself, one past it) and the fields a reel must not
 * carry - a poll on something that expires in a month, a schedule that would start the month before
 * anybody could see it.
 */
import { BadRequestException, ForbiddenException, type Logger } from '@nestjs/common';
import { assertNotReplay } from './republications.service';
import { assertCreateKindShape, assertReelEditShape } from './reel-rules';
import {
  CHAT_REEL_MAX_DURATION_MS,
  CHAT_REEL_MAX_TARGETS,
  REEL_MAX_ASPECT_RATIO,
  REEL_MAX_DURATION_MS,
  REEL_RETENTION_DAYS,
  REEL_VERTICAL_MAX_DURATION_MS,
  isExpiredPost,
  isReelFrame,
  isReelVideo,
  reelLimits,
} from './reel.constants';

const video = { type: 'video', mimeType: 'video/mp4', width: 720, height: 1280 };
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

  it('accepts a vertical reel up to its cap exactly and refuses one millisecond past it', () => {
    expect(() =>
      assertCreateKindShape(reel({ durationMs: REEL_VERTICAL_MAX_DURATION_MS }))
    ).not.toThrow();
    expect(() =>
      assertCreateKindShape(reel({ durationMs: REEL_VERTICAL_MAX_DURATION_MS + 1 }))
    ).toThrow(BadRequestException);
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

describe('assertCreateKindShape - a reel is VERTICAL OR SHORT (owner, 2026-11-14)', () => {
  const LONG = REEL_MAX_DURATION_MS + 5_000;
  const framed = (width?: number, height?: number, durationMs = 41_250) =>
    reel({ durationMs, media: [{ type: 'video', mimeType: 'video/mp4', width, height }] });

  it.each([
    ['9:16, a phone held upright', 720, 1280],
    ['3:4, the iOS system camera', 360, 480],
    ['4:5 exactly, the widest vertical frame', 1080, 1350],
  ])('accepts %s, short or long', (_label, width, height) => {
    expect(() => assertCreateKindShape(framed(width, height))).not.toThrow();
    expect(() => assertCreateKindShape(framed(width, height, LONG))).not.toThrow();
  });

  it.each([
    ['one pixel wider than 4:5', 1081, 1350],
    ['a square', 1080, 1080],
    ['landscape 16:9', 1280, 720],
    ['no dimensions', undefined, undefined],
    ['a width only', 720, undefined],
    ['a zero height', 720, 0],
  ])('accepts %s when SHORT, and refuses it past 90 s', (_label, width, height) => {
    expect(() => assertCreateKindShape(framed(width, height))).not.toThrow();
    expect(() => assertCreateKindShape(framed(width, height, REEL_MAX_DURATION_MS))).not.toThrow();
    expect(() => assertCreateKindShape(framed(width, height, REEL_MAX_DURATION_MS + 1))).toThrow(
      BadRequestException
    );
  });

  it('accepts what a client OLDER than the rule declares: a vertical reel of 90 s or less', () => {
    expect(() => assertCreateKindShape(framed(720, 1280, REEL_MAX_DURATION_MS))).not.toThrow();
  });

  it('leaves an ordinary post alone whatever its video is: a landscape video stays a post', () => {
    expect(() =>
      assertCreateKindShape({
        markdown: '',
        media: [{ type: 'video', mimeType: 'video/mp4', width: 1280, height: 720 }],
      })
    ).not.toThrow();
  });
});

describe('isReelFrame', () => {
  it('reads width / height against the served 4:5', () => {
    expect(REEL_MAX_ASPECT_RATIO).toBe(0.8);
    expect(isReelFrame(800, 1000)).toBe(true);
    expect(isReelFrame(801, 1000)).toBe(false);
  });

  it.each([
    ['strings', '720', '1280'],
    ['NaN', Number.NaN, 1280],
    ['Infinity', 720, Number.POSITIVE_INFINITY],
    ['a negative width', -720, 1280],
  ])('is false on %s', (_label, width, height) => {
    expect(isReelFrame(width, height)).toBe(false);
  });
});

describe('isReelVideo - the rule on one declared video', () => {
  it.each([
    ['a short landscape video', 30_000, 1920, 1080, true],
    ['a long vertical video', 150_000, 1080, 1920, true],
    ['a long landscape video', 90_001, 1920, 1080, false],
    ['a vertical video past its cap', REEL_VERTICAL_MAX_DURATION_MS + 1, 1080, 1920, false],
    ['a short video with no frame', 5_000, undefined, undefined, true],
    ['a length that is not an integer', 5_000.5, 1080, 1920, false],
    ['no length at all', undefined, 1080, 1920, false],
  ])('%s: %s', (_label, durationMs, width, height, expected) => {
    expect(isReelVideo(durationMs, width, height)).toBe(expected);
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

describe('isExpiredPost', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');

  it('is true for a reel at or past its expiry, false before it', () => {
    expect(isExpiredPost({ kind: 'reel', expiresAt: new Date(now - 1) }, now)).toBe(true);
    expect(isExpiredPost({ kind: 'reel', expiresAt: new Date(now) }, now)).toBe(true);
    expect(isExpiredPost({ kind: 'reel', expiresAt: new Date(now + 1) }, now)).toBe(false);
    // A live replay expires by the same column (docs/wiki/live-replays.md).
    expect(isExpiredPost({ kind: 'replay', expiresAt: new Date(now) }, now)).toBe(true);
    expect(isExpiredPost({ kind: 'replay', expiresAt: new Date(now + 1) }, now)).toBe(false);
  });

  it('is never true for a post, whatever its columns say', () => {
    expect(isExpiredPost({ kind: 'post', expiresAt: new Date(0) }, now)).toBe(false);
    expect(isExpiredPost({ expiresAt: new Date(0) }, now)).toBe(false);
    expect(isExpiredPost({ kind: 'reel', expiresAt: null }, now)).toBe(false);
  });
});

describe('reelLimits - the numbers a client reads', () => {
  it('serves the chat cap (60 s, D-size) next to the published reel cap (90 s)', () => {
    expect(reelLimits(365)).toMatchObject({
      maxDurationMs: 90_000,
      chatMaxDurationMs: CHAT_REEL_MAX_DURATION_MS,
    });
    expect(CHAT_REEL_MAX_DURATION_MS).toBe(60_000);
    expect(CHAT_REEL_MAX_DURATION_MS).toBeLessThan(REEL_MAX_DURATION_MS);
  });

  it('serves the vertical rule and the lifetime it is GIVEN - the admin setting in force (2026-11-14)', () => {
    expect(reelLimits(180)).toMatchObject({ maxAspectRatio: 0.8, retentionDays: 180 });
    expect(REEL_RETENTION_DAYS).toBe(365);
  });

  it('serves the rule a client applies only when it reads it - the version-skew gate (2026-11-14)', () => {
    expect(reelLimits(365)).toMatchObject({
      rule: 'vertical-or-short',
      maxDurationMs: REEL_MAX_DURATION_MS,
      maxVerticalDurationMs: REEL_VERTICAL_MAX_DURATION_MS,
    });
    expect(REEL_VERTICAL_MAX_DURATION_MS).toBe(180_000);
  });

  it('serves the target cap of one "Envoyer à..." press (15.2), so no client carries it', () => {
    expect(reelLimits(365).chatReelMaxTargets).toBe(CHAT_REEL_MAX_TARGETS);
    expect(CHAT_REEL_MAX_TARGETS).toBe(15);
  });
});

describe('assertNotReplay - a live replay is never reposted (owner, 2026-11-09, D6)', () => {
  const logger = { debug: jest.fn() } as unknown as Logger;

  it('refuses a replay with the typed 403 POST_REPLAY_NOT_REPOSTABLE', () => {
    let caught: unknown;
    try {
      assertNotReplay({ id: 'p1', kind: 'replay' }, logger);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getResponse()).toMatchObject({
      code: 'POST_REPLAY_NOT_REPOSTABLE',
    });
  });

  it('lets a post and a reel through', () => {
    expect(() => assertNotReplay({ id: 'p1', kind: 'post' }, logger)).not.toThrow();
    expect(() => assertNotReplay({ id: 'p1', kind: 'reel' }, logger)).not.toThrow();
  });
});
