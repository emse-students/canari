import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BlobUrlPool, BLOB_URL_EVICT_DELAY_MS } from './blobUrlPool';

describe('BlobUrlPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('URL', {
      revokeObjectURL: vi.fn(),
      createObjectURL: vi.fn(() => 'blob:test'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reuses the same blob URL across retain/release cycles within the eviction window', () => {
    const pool = new BlobUrlPool();
    const first = pool.retain('a', 'blob:first');
    expect(first).toBe('blob:first');

    pool.release('a');
    vi.advanceTimersByTime(BLOB_URL_EVICT_DELAY_MS - 1);

    const second = pool.tryRetain('a');
    expect(second).toBe('blob:first');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the blob URL after the eviction delay when unused', () => {
    const pool = new BlobUrlPool();
    pool.retain('a', 'blob:first');
    pool.release('a');

    vi.advanceTimersByTime(BLOB_URL_EVICT_DELAY_MS);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');

    expect(pool.tryRetain('a')).toBeNull();
  });
});
