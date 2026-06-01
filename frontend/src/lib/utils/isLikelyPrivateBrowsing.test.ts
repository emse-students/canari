import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isLikelyPrivateBrowsing } from './isLikelyPrivateBrowsing';

describe('isLikelyPrivateBrowsing', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req = {
          onerror: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          result: { close: () => {} },
        };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
      deleteDatabase: () => ({ onsuccess: null }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when localStorage and indexedDB work', async () => {
    await expect(isLikelyPrivateBrowsing()).resolves.toBe(false);
  });

  it('returns true when localStorage throws', async () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => {},
    });
    await expect(isLikelyPrivateBrowsing()).resolves.toBe(true);
  });
});
