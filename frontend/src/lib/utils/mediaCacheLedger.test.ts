// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CIPHER_CACHE_NAME,
  LEDGER_CACHE_NAME,
  cipherCacheKey,
  dropMediaCacheLedgerMemory,
  enforceMediaCacheCap,
  forgetCipher,
  recordCipherWritten,
  recordServerConfirmed,
} from './mediaCacheLedger';
import { writeMediaCacheCap } from './mediaCacheCap';

vi.mock('./sessionLog', () => ({ appendLog: vi.fn() }));

const MB = 1024 * 1024;
const BASE = 'https://media.test';
const DAY = 24 * 60 * 60 * 1000;
const abs = (key: string) => new URL(key, 'http://localhost/').href;

type Buckets = Map<string, Map<string, Response>>;

/** A Cache Storage with named buckets of Responses, keyed by absolute URL like the real one. */
function installCaches(): Buckets {
  const buckets: Buckets = new Map();
  const bucket = (name: string) => {
    let b = buckets.get(name);
    if (!b) buckets.set(name, (b = new Map()));
    const held = b;
    return {
      keys: async () => [...held.keys()].map((url) => new Request(url)),
      match: async (k: string | Request) =>
        held.get(typeof k === 'string' ? abs(k) : k.url)?.clone(),
      put: async (k: string, r: Response) => {
        held.set(abs(k), r);
      },
      delete: async (k: string) => held.delete(abs(k)),
    };
  };
  vi.stubGlobal('caches', { open: async (name: string) => bucket(name), delete: vi.fn() });
  return buckets;
}

/** A response that DECLARES its weight: a tiny body, so the cases do not allocate megabytes. */
const weighing = (bytes: number) =>
  new Response('x', { headers: { 'content-length': String(bytes) } });

/** Stores a ciphertext of `mb` megabytes the way a download does, ledger record included. */
async function download(buckets: Buckets, mediaId: string, mb: number, at: number) {
  const key = cipherCacheKey(BASE, mediaId);
  const bytes = mb * MB;
  const cipher = buckets.get(CIPHER_CACHE_NAME) ?? new Map<string, Response>();
  buckets.set(CIPHER_CACHE_NAME, cipher);
  cipher.set(abs(key), weighing(bytes));
  await recordCipherWritten(key, bytes, at);
}

describe('the media cache ledger and its cap', () => {
  beforeEach(() => {
    localStorage.clear();
    dropMediaCacheLedgerMemory();
  });

  it('keeps the cache under 250 MB by evicting the least recently used confirmed copies', async () => {
    const buckets = installCaches();
    writeMediaCacheCap(250 * MB);
    const now = Date.now();
    await download(buckets, 'old', 100, now - 5 * DAY);
    await download(buckets, 'middle', 100, now - 3 * DAY);
    await download(buckets, 'new', 100, now - 1 * DAY);
    await enforceMediaCacheCap(now);

    const held = [...buckets.get(CIPHER_CACHE_NAME)!.keys()].map((k) => decodeURIComponent(k));
    expect(held.some((k) => k.endsWith('/old'))).toBe(false);
    expect(held.filter((k) => /\/(middle|new)$/.test(k))).toHaveLength(2);
    // The evicted copy's record left with it.
    expect(buckets.get(LEDGER_CACHE_NAME)!.size).toBe(2);
  });

  it('keeps a copy it never saw the server confirm, and weighs it once', async () => {
    const buckets = installCaches();
    writeMediaCacheCap(250 * MB);
    const key = cipherCacheKey(BASE, 'legacy');
    buckets.set(CIPHER_CACHE_NAME, new Map([[abs(key), weighing(300 * MB)]]));
    await enforceMediaCacheCap(Date.now());
    expect(buckets.get(CIPHER_CACHE_NAME)!.size).toBe(1);
    const record = [...buckets.get(LEDGER_CACHE_NAME)!.values()][0];
    expect(record.headers.get('x-canari-bytes')).toBe(String(300 * MB));
    expect(record.headers.get('x-canari-confirmed')).toBe('0');

    // The server's acknowledged touch confirms it; only then may the cap take it.
    await recordServerConfirmed(BASE, ['legacy'], Date.now());
    await enforceMediaCacheCap(Date.now());
    expect(buckets.get(CIPHER_CACHE_NAME)!.size).toBe(0);
  });

  it('does nothing when the member chose unlimited', async () => {
    const buckets = installCaches();
    writeMediaCacheCap(null);
    const now = Date.now();
    await download(buckets, 'a', 300, now);
    await download(buckets, 'b', 300, now);
    await enforceMediaCacheCap(now);
    expect(buckets.get(CIPHER_CACHE_NAME)!.size).toBe(2);
  });

  it('forgetting a ciphertext drops its record', async () => {
    const buckets = installCaches();
    writeMediaCacheCap(null);
    await download(buckets, 'a', 1, Date.now());
    expect(buckets.get(LEDGER_CACHE_NAME)!.size).toBe(1);
    await forgetCipher(cipherCacheKey(BASE, 'a'));
    expect(buckets.get(LEDGER_CACHE_NAME)!.size).toBe(0);
  });
});
