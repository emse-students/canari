import { getDeviceStorageUsage, clearMediaCache, formatStorageBytes } from './deviceStorage';
import { CIPHER_CACHE_NAME } from './mediaBlobCache';
import { CACHE_NAME as AVATAR_CACHE_NAME } from './userAvatarCache';
import { CACHE_NAME as ASSOCIATION_LOGO_CACHE_NAME } from './associationLogoCache';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function pretendTauri() {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

/** A minimal fake Cache Storage: each bucket holds a fixed set of byte sizes. */
function installFakeCaches(sizesByBucket: Record<string, number[]>) {
  const cachesByName = new Map<string, ReturnType<typeof makeFakeCache>>();

  function makeFakeCache(sizes: number[]) {
    const entries = sizes.map((size, i) => ({
      request: new Request(`https://example.test/${i}`),
      size,
    }));
    return {
      async keys() {
        return entries.map((e) => e.request);
      },
      async match(request: Request) {
        const entry = entries.find((e) => e.request.url === request.url);
        if (!entry) return undefined;
        return new Response(new Uint8Array(entry.size), {
          headers: { 'content-length': String(entry.size) },
        });
      },
    };
  }

  const fakeCaches = {
    async open(name: string) {
      if (!cachesByName.has(name)) {
        cachesByName.set(name, makeFakeCache(sizesByBucket[name] ?? []));
      }
      return cachesByName.get(name);
    },
    async delete(name: string) {
      return cachesByName.delete(name);
    },
  };

  (globalThis as { caches?: unknown }).caches = fakeCaches;
  return fakeCaches;
}

describe('deviceStorage', () => {
  beforeEach(() => {
    invoke.mockReset();
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    delete (globalThis as { caches?: unknown }).caches;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: undefined,
    });
  });

  describe('getDeviceStorageUsage', () => {
    it('sums Content-Length across the media, avatar and logo buckets', async () => {
      installFakeCaches({
        [CIPHER_CACHE_NAME]: [1000, 2000],
        [AVATAR_CACHE_NAME]: [500],
        [ASSOCIATION_LOGO_CACHE_NAME]: [],
      });

      const usage = await getDeviceStorageUsage();

      expect(usage.mediaCacheBytes).toBe(3500);
    });

    it('reads the native breakdown via the Tauri command, keeping mls.bin separate', async () => {
      installFakeCaches({ [CIPHER_CACHE_NAME]: [100] });
      pretendTauri();
      invoke.mockResolvedValue({
        messages_bytes: 40_000,
        encryption_state_bytes: 2_000,
        other_bytes: 500,
      });

      const usage = await getDeviceStorageUsage();

      expect(invoke).toHaveBeenCalledWith('get_local_storage_usage');
      expect(usage.mediaCacheBytes).toBe(100);
      expect(usage.messagesBytes).toBe(40_500);
      expect(usage.encryptionStateBytes).toBe(2_000);
      expect(usage.totalBytes).toBe(100 + 40_500 + 2_000);
    });

    it('falls back to the cache-only total when the native command fails, rather than throwing', async () => {
      installFakeCaches({ [CIPHER_CACHE_NAME]: [100] });
      pretendTauri();
      invoke.mockRejectedValue(new Error('no such command'));

      const usage = await getDeviceStorageUsage();

      expect(usage.mediaCacheBytes).toBe(100);
      expect(usage.encryptionStateBytes).toBeNull();
      expect(usage.totalBytes).toBe(100);
    });

    it('on the web, derives messages from the origin estimate minus the measured cache', async () => {
      installFakeCaches({ [CIPHER_CACHE_NAME]: [1000] });
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ usage: 5000 }) },
      });

      const usage = await getDeviceStorageUsage();

      expect(usage.mediaCacheBytes).toBe(1000);
      expect(usage.messagesBytes).toBe(4000);
      expect(usage.encryptionStateBytes).toBeNull();
      expect(usage.totalBytes).toBe(5000);
    });

    it('never reports a negative "everything else" when the two web measurements race', async () => {
      // The cache and the origin estimate are read a moment apart; a cache write in between
      // can make the cache look bigger than the origin total that was captured first.
      installFakeCaches({ [CIPHER_CACHE_NAME]: [9000] });
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ usage: 100 }) },
      });

      const usage = await getDeviceStorageUsage();

      expect(usage.messagesBytes).toBe(0);
    });
  });

  describe('clearMediaCache', () => {
    it('deletes exactly the media, avatar and logo buckets, never anything else', async () => {
      const fakeCaches = installFakeCaches({
        [CIPHER_CACHE_NAME]: [1],
        [AVATAR_CACHE_NAME]: [1],
        [ASSOCIATION_LOGO_CACHE_NAME]: [1],
      });
      const deleteSpy = vi.spyOn(fakeCaches, 'delete');

      await clearMediaCache();

      expect(deleteSpy).toHaveBeenCalledWith(CIPHER_CACHE_NAME);
      expect(deleteSpy).toHaveBeenCalledWith(AVATAR_CACHE_NAME);
      expect(deleteSpy).toHaveBeenCalledWith(ASSOCIATION_LOGO_CACHE_NAME);
      expect(deleteSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('formatStorageBytes', () => {
    it.each([
      [0, '0 o'],
      [512, '512 o'],
      [1536, '1.5 Ko'],
      [5 * 1024 * 1024, '5.0 Mo'],
      [2 * 1024 * 1024 * 1024, '2.0 Go'],
    ])('formats %i bytes as %s', (bytes, expected) => {
      expect(formatStorageBytes(bytes)).toBe(expected);
    });
  });
});
