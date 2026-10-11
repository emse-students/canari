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

  /**
   * THE POLICY THE AVATAR AND LOGO CACHES ASK FOR. They held their own counting code until
   * 2026-09-16 precisely because this pool always delayed, and their bytes are not worth keeping
   * past the last holder. Zero revokes SYNCHRONOUSLY - not on a 0 ms timer - so a caller that
   * releases and re-renders in the same tick cannot observe a URL about to die.
   */
  it('revokes immediately, without advancing any timer, when evictDelayMs is 0', () => {
    const pool = new BlobUrlPool({ evictDelayMs: 0, maxEntries: Infinity });
    pool.retain('a', 'blob:first');

    pool.release('a');

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
    expect(pool.tryRetain('a')).toBeNull();
  });

  it('ignores a release of null, which is what a cache with no URL hands it', () => {
    const pool = new BlobUrlPool({ evictDelayMs: 0 });

    expect(() => pool.release(null)).not.toThrow();
  });

  /**
   * THE LEAK THE THREE IMPLEMENTATIONS DISAGREED ABOUT. Two loads of the same key can both finish;
   * the blob already on screen must survive, and the redundant one must not be left behind.
   */
  it('keeps the displayed blob and revokes the redundant one', () => {
    const pool = new BlobUrlPool();
    pool.retain('a', 'blob:first');

    const kept = pool.retain('a', 'blob:second');

    expect(kept).toBe('blob:first');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:first');
  });

  /**
   * THE CAP IS BYTES, NOT ENTRIES (reels audit, 2026-10-11): ten reels of 30 MB are ten entries of
   * a 200-entry cap, and were all kept for five minutes. Past the byte cap the least recently used
   * IDLE entry goes at once, and a HELD one - the video on screen - never does.
   */
  it('evicts idle entries least recently used first once the byte cap is exceeded', () => {
    const pool = new BlobUrlPool({ maxBytes: 100 });
    pool.retain('old', 'blob:old', 40);
    vi.advanceTimersByTime(1);
    pool.retain('recent', 'blob:recent', 40);
    pool.release('old');
    vi.advanceTimersByTime(1);
    pool.release('recent');

    pool.retain('new', 'blob:new', 40);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:recent');
    expect(pool.bytes).toBe(80);
    expect(pool.tryRetain('old')).toBeNull();
    expect(pool.tryRetain('recent')).toBe('blob:recent');
  });

  it('never evicts a held entry to honour the byte cap', () => {
    const pool = new BlobUrlPool({ maxBytes: 100 });
    pool.retain('playing', 'blob:playing', 80);
    pool.retain('next', 'blob:next', 80);

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(pool.bytes).toBe(160);
  });

  /**
   * A SOFT CAP (review of #1744): a release over the cap used to evict at once, so a feed page torn
   * down by a tab swipe lost its warm videos past 64 MiB. The grace holds until a new blob needs
   * the room.
   */
  it('keeps a released entry warm over the cap until a new blob needs the room', () => {
    const pool = new BlobUrlPool({ maxBytes: 100 });
    pool.retain('a', 'blob:a', 80);
    pool.retain('b', 'blob:b', 80);
    pool.release('a');
    pool.release('b');

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pool.tryRetain('a')).toBe('blob:a');
    pool.release('a');

    vi.advanceTimersByTime(1);
    pool.retain('c', 'blob:c', 10);
    // `b` was released first and not touched since: it goes; `a` (retained again) stays.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:a');
  });

  it('keeps a blob alive while another holder remains', () => {
    const pool = new BlobUrlPool({ evictDelayMs: 0 });
    pool.retain('a', 'blob:first');
    pool.tryRetain('a');

    pool.release('a');

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(pool.tryRetain('a')).toBe('blob:first');
  });
});
