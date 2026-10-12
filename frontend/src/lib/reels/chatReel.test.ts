import { describe, expect, it } from 'vitest';
import type { MediaRef } from '$lib/media';
import { isReelMessage, isReelMessageExpired, reelMessageAsPost } from './chatReel';

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
