import { describe, expect, it } from 'vitest';
import { isOrphanMediaRef } from './orphanMedia';
import type { MediaRef } from '$lib/media';

const ref = (mediaId: string): MediaRef =>
  ({ type: 'file', mediaId, key: '', iv: '', mimeType: 'application/pdf', size: 0 }) as MediaRef;

describe('isOrphanMediaRef', () => {
  it('is false for text-only messages', () => {
    expect(isOrphanMediaRef(null)).toBe(false);
    expect(isOrphanMediaRef(undefined)).toBe(false);
  });
  it('is true for a reference with an empty mediaId', () => {
    expect(isOrphanMediaRef(ref(''))).toBe(true);
  });
  it('is false once the upload gave the reference its id', () => {
    expect(isOrphanMediaRef(ref('abc'))).toBe(false);
  });
});
