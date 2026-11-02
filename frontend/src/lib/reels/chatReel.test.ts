import { describe, expect, it } from 'vitest';
import type { MediaRef } from '$lib/media';
import {
  isReelMessage,
  isReelMessageExpired,
  reelMessageAsPost,
  reelTombstoneOf,
} from './chatReel';

const video: MediaRef = {
  type: 'video',
  mediaId: 'm',
  key: 'k',
  iv: 'i',
  mimeType: 'video/mp4',
  size: 1,
};

describe('isReelMessage', () => {
  it("is the sender's declared intent on a video, nothing else", () => {
    expect(isReelMessage({ ...video, intent: 'reel-message' })).toBe(true);
    expect(isReelMessage(video)).toBe(false);
    expect(isReelMessage({ ...video, type: 'image', intent: 'reel-message' })).toBe(false);
    expect(isReelMessage(null)).toBe(false);
  });
});

describe('isReelMessageExpired', () => {
  const now = 1_000_000;
  it('reads the hint against the clock it is given', () => {
    expect(isReelMessageExpired({ expiresAtMs: now - 1 }, now)).toBe(true);
    expect(isReelMessageExpired({ expiresAtMs: now }, now)).toBe(true);
    expect(isReelMessageExpired({ expiresAtMs: now + 1 }, now)).toBe(false);
  });
  it('is not expired without a hint', () => {
    expect(isReelMessageExpired({}, now)).toBe(false);
    expect(isReelMessageExpired({ expiresAtMs: 0 }, now)).toBe(false);
  });
});

describe('reelTombstoneOf', () => {
  const hint = 1_000_000;
  it('is watchable while the hint is ahead and no 410 was met', () => {
    expect(reelTombstoneOf({ expiresAtMs: hint }, undefined, hint - 1)).toBeNull();
    expect(reelTombstoneOf({}, null, hint)).toBeNull();
  });
  it('reads "expired" from the hint alone, without a request', () => {
    expect(reelTombstoneOf({ expiresAtMs: hint }, undefined, hint)).toBe('expired');
  });
  it('reads "deleted" when the 410 came BEFORE the hint, whatever the clock says now', () => {
    expect(reelTombstoneOf({ expiresAtMs: hint }, hint - 1, hint - 1)).toBe('deleted');
    expect(reelTombstoneOf({ expiresAtMs: hint }, hint - 1, hint + 86_400_000)).toBe('deleted');
  });
  it('reads "expired" when the 410 came at or after the hint', () => {
    expect(reelTombstoneOf({ expiresAtMs: hint }, hint, hint)).toBe('expired');
    expect(reelTombstoneOf({ expiresAtMs: hint }, hint + 5, hint + 5)).toBe('expired');
  });
  it('reads a 410 on a reel with no hint as "expired", the neutral reading', () => {
    expect(reelTombstoneOf({}, 42, 42)).toBe('expired');
    expect(reelTombstoneOf({ expiresAtMs: 0 }, 42, 42)).toBe('expired');
  });
});

describe('reelMessageAsPost', () => {
  it('gives the viewer the video with its key, the sender and the day', () => {
    const sentAt = new Date('2026-10-09T10:00:00Z');
    const post = reelMessageAsPost({
      messageId: 'msg-9',
      media: { ...video, intent: 'reel-message' },
      caption: 'hello',
      senderName: 'Ada',
      sentAt,
    });
    expect(post.id).toBe('msg-9');
    expect(post.media[0].key).toBe('k');
    expect(post.markdown).toBe('hello');
    expect(post.authorDisplayName).toBe('Ada');
    expect(post.createdAt).toBe(sentAt.toISOString());
    expect(post.authorId).toBeUndefined();
  });
});
