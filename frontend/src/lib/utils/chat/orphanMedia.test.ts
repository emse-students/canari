import { describe, expect, it } from 'vitest';
import { isOrphanMediaCandidate } from './orphanMedia';
import type { MediaRef } from '$lib/media';

const ref = (mediaId: string): MediaRef =>
  ({ type: 'file', mediaId, key: '', iv: '', mimeType: 'application/pdf', size: 0 }) as MediaRef;
const base = { mediaRef: ref(''), isOwn: true, hasUpload: false, uploadFailed: false };

describe('isOrphanMediaCandidate', () => {
  it('is true for my attachment with no id and nothing advancing it', () => {
    expect(isOrphanMediaCandidate(base)).toBe(true);
  });
  it('is false for text, for a ref with an id, and for a received row', () => {
    expect(isOrphanMediaCandidate({ ...base, mediaRef: null })).toBe(false);
    expect(isOrphanMediaCandidate({ ...base, mediaRef: ref('abc') })).toBe(false);
    expect(isOrphanMediaCandidate({ ...base, isOwn: false })).toBe(false);
  });
  it('is false while an upload runs or after the refusal that has its own state', () => {
    expect(isOrphanMediaCandidate({ ...base, hasUpload: true })).toBe(false);
    expect(isOrphanMediaCandidate({ ...base, uploadFailed: true })).toBe(false);
  });
});
