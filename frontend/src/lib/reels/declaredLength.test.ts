import { describe, expect, it } from 'vitest';
import { declaredLengthMs } from './declaredLength';
import type { PostMediaRef } from '$lib/posts/api';

const ref = (extra: object = {}) => ({ mediaId: 'm', ...extra }) as unknown as PostMediaRef;

describe('declaredLengthMs', () => {
  it('reads a CanaReel post length', () => {
    expect(declaredLengthMs({ durationMs: 8000 }, ref(), 'reel')).toBe(8000);
  });

  it("reads a conversation reel's media length, which the post shape does not carry", () => {
    expect(declaredLengthMs({}, ref({ durationMs: 12_000 }), 'reel')).toBe(12_000);
  });

  it("prefers the media's own declaration over the post's", () => {
    expect(declaredLengthMs({ durationMs: 8000 }, ref({ durationMs: 7900 }), 'reel')).toBe(7900);
  });

  it('declares nothing for a post of one video that is not a reel, or a carousel video', () => {
    expect(declaredLengthMs({ durationMs: null }, ref(), 'reel')).toBeNull();
    expect(declaredLengthMs({ durationMs: 8000 }, ref(), 'carousel')).toBeNull();
  });

  it('ignores a zero or negative declaration', () => {
    expect(declaredLengthMs({ durationMs: 0 }, ref({ durationMs: -1 }), 'reel')).toBeNull();
  });
});
