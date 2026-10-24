// @vitest-environment happy-dom
/**
 * ONE REQUEST PER AVATAR, NONE AT ALL FOR A FACE WE HAVE ALREADY BEEN TOLD DOES NOT EXIST, AND
 * NOTHING KEPT PAST WHAT THE SERVER SAID.
 *
 * Two defects are pinned here, and both were invisible in the UI.
 *
 * The first: a miss returned the HTTP URL, the caller handed it to an `<img>`, and the server was
 * asked a second time for the answer it had just given. Nothing looked wrong - initials appeared
 * either way - while every account without a photo doubled the outbound traffic of every list it
 * appeared in, on every mount.
 *
 * The second, and the reason one person had three different faces on three devices: the bytes were
 * stored in Cache Storage, which ignores `Cache-Control` and performs no freshness check, so the
 * first photo a device ever drew was the photo it kept FOR EVER. The guard is therefore that
 * NOTHING IS EVER WRITTEN TO CACHE STORAGE and that a later mount asks again - the browser's HTTP
 * cache, and only it, decides whether that question reaches the network. Since 2026-10-16 a blob
 * also outlives its last holder by AVATAR_WARM_MS, so a remount inside that window asks nobody.
 */
import {
  resolveUserAvatarDisplayUrl,
  releaseUserAvatarDisplayUrl,
  purgeRetiredAvatarCache,
  AVATAR_WARM_MS,
  AVATAR_POOL_MAX_ENTRIES,
} from './userAvatarCache';
import { mirrorAvatarToNative } from './avatarMirror';

vi.mock('./avatarMirror', () => ({ mirrorAvatarToNative: vi.fn(async () => {}) }));
// "Nobody could say" unless a test states otherwise: the avatar is then requested, as before the
// presence answer existed - which is what every test below the presence one measures.
const presence = vi.fn<(userId: string) => Promise<boolean | null>>(async () => null);
vi.mock('./avatarPresence', () => ({ avatarPhotoPresence: (id: string) => presence(id) }));

/** A fresh URL per test: the module holds live blobs keyed by URL, so tests must not share one. */
let urlCounter = 0;
function nextUrl(): string {
  return `https://canari-emse.fr/api/users/u${++urlCounter}/avatar`;
}

let revoked: string[] = [];

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The pool is module state and now keeps idle blobs warm: drop the previous test's, so each test
  // starts cold (the reader-change hook is the production path that does exactly this).
  (await import('./sharedCache')).forgetReaderCaches();
  revoked = [];
  let blobCounter = 0;
  // Blob URLs are created by the happy path; jsdom has no implementation.
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => `blob:${++blobCounter}`,
      revokeObjectURL: (u: string) => void revoked.push(u),
    })
  );
});

describe('resolveUserAvatarDisplayUrl', () => {
  it('hands the bytes of a load to the notification cache once, under the id it was given', async () => {
    const mirror = vi.mocked(mirrorAvatarToNative);
    mirror.mockClear();
    const url = nextUrl();
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));

    await Promise.all([
      resolveUserAvatarDisplayUrl(url, 'user-7'),
      resolveUserAvatarDisplayUrl(url, 'user-7'),
    ]);
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mock.calls[0][0]).toBe('user-7');
    releaseUserAvatarDisplayUrl(url);
    releaseUserAvatarDisplayUrl(url);

    // An absence is not a face, and a caller that names nobody mirrors nothing.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await resolveUserAvatarDisplayUrl(nextUrl(), 'user-8');
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));
    const anonymous = nextUrl();
    await resolveUserAvatarDisplayUrl(anonymous);
    releaseUserAvatarDisplayUrl(anonymous);
    expect(mirror).toHaveBeenCalledTimes(1);
  });

  // Mi 9T, 2026-10-13: 25 refused avatar requests in one salon open. The list's presence answer
  // says which faces exist, and a face without one is never requested.
  it('requests nothing for a face the presence answer says has no photo, and remembers it', async () => {
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    presence.mockResolvedValueOnce(false);

    expect(await resolveUserAvatarDisplayUrl(url, 'no-photo')).toEqual({ kind: 'none' });
    expect(await resolveUserAvatarDisplayUrl(url, 'no-photo')).toEqual({ kind: 'none' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests a face the presence answer says has a photo', async () => {
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    presence.mockResolvedValueOnce(true);

    expect((await resolveUserAvatarDisplayUrl(url, 'with-photo')).kind).toBe('blob');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    releaseUserAvatarDisplayUrl(url);
  });

  it('asks once and reports `none` when the server says there is no avatar', async () => {
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveUserAvatarDisplayUrl(url)).toEqual({ kind: 'none' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('answers `blob` without writing anything to Cache Storage', async () => {
    const url = nextUrl();
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));
    // A bucket that fails loudly if it is opened at all: keeping avatars across sessions is
    // EXACTLY the defect, so the assertion is that this store is never touched.
    const open = vi.fn(() => {
      throw new Error('Cache Storage must never hold an avatar');
    });
    vi.stubGlobal('caches', { open, delete: async () => false });

    const first = await resolveUserAvatarDisplayUrl(url);
    expect(first.kind).toBe('blob');
    expect(open).not.toHaveBeenCalled();
    releaseUserAvatarDisplayUrl(url);
  });

  describe('the warm window', () => {
    afterEach(() => vi.useRealTimers());

    it('answers a remount inside the window from memory: no presence wait, no request', async () => {
      vi.useFakeTimers();
      const url = nextUrl();
      const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      presence.mockClear();

      const first = await resolveUserAvatarDisplayUrl(url, 'u-warm');
      releaseUserAvatarDisplayUrl(url);
      vi.advanceTimersByTime(AVATAR_WARM_MS - 1);
      const second = await resolveUserAvatarDisplayUrl(url, 'u-warm');
      releaseUserAvatarDisplayUrl(url);

      expect(second).toEqual(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(presence).toHaveBeenCalledTimes(1);
      expect(revoked).toEqual([]);
    });

    it('asks the server again once the window has passed, and revokes the old blob', async () => {
      // THE STALE-AVATAR GUARD. Staleness is bounded by this window and by nothing else here.
      vi.useFakeTimers();
      const url = nextUrl();
      const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      const first = await resolveUserAvatarDisplayUrl(url);
      releaseUserAvatarDisplayUrl(url);
      vi.advanceTimersByTime(AVATAR_WARM_MS + 1);
      expect(revoked).toEqual([first.kind === 'blob' ? first.url : '']);
      const second = await resolveUserAvatarDisplayUrl(url);
      releaseUserAvatarDisplayUrl(url);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(first).not.toEqual(second);
    });

    it('never revokes a blob a mount still holds, however long it has been', async () => {
      vi.useFakeTimers();
      const url = nextUrl();
      vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));
      await resolveUserAvatarDisplayUrl(url);
      vi.advanceTimersByTime(AVATAR_WARM_MS * 10);
      expect(revoked).toEqual([]);
      releaseUserAvatarDisplayUrl(url);
    });

    it('forgets the warm faces when the signed-in reader changes', async () => {
      vi.useFakeTimers();
      const { forgetReaderCaches } = await import('./sharedCache');
      const url = nextUrl();
      const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      await resolveUserAvatarDisplayUrl(url, 'u-a');
      releaseUserAvatarDisplayUrl(url);
      forgetReaderCaches();
      await resolveUserAvatarDisplayUrl(url, 'u-a');
      releaseUserAvatarDisplayUrl(url);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(revoked).toHaveLength(1);
    });

    it('is bounded: past the entry cap the idlest warm face is revoked', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));
      const first = nextUrl();
      await resolveUserAvatarDisplayUrl(first);
      releaseUserAvatarDisplayUrl(first);
      for (let i = 0; i < AVATAR_POOL_MAX_ENTRIES; i++) {
        vi.advanceTimersByTime(1);
        const u = nextUrl();
        await resolveUserAvatarDisplayUrl(u);
        releaseUserAvatarDisplayUrl(u);
      }
      expect(revoked).toHaveLength(1);
    });
  });

  it('costs one request when the same face mounts several times at once', async () => {
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const [a, b, c] = await Promise.all([
      resolveUserAvatarDisplayUrl(url),
      resolveUserAvatarDisplayUrl(url),
      resolveUserAvatarDisplayUrl(url),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);

    // Each of the three holds it: the blob survives until the last one lets go, and is revoked
    // exactly once. Releasing on the first unmount is what used to blank the two others.
    releaseUserAvatarDisplayUrl(url);
    releaseUserAvatarDisplayUrl(url);
    releaseUserAvatarDisplayUrl(url);
    // The last release starts the warm window rather than revoking (see 'the warm window').
    expect(revoked).toEqual([]);
  });

  it('falls back to the element - loudly - only when it could not ask at all', async () => {
    const url = nextUrl();
    // A cross-origin refusal: `fetch` throws where an `<img>` would still render. That is a
    // different question, not a retry of this one, which is why it is `direct` and not `none`.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    expect(await resolveUserAvatarDisplayUrl(url)).toEqual({ kind: 'direct', url });
    expect(debug).toHaveBeenCalled();
  });

  it('draws avatars on a client that has no Cache Storage at all', async () => {
    const url = nextUrl();
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));

    expect((await resolveUserAvatarDisplayUrl(url)).kind).toBe('blob');
    releaseUserAvatarDisplayUrl(url);
  });

  it('answers `none` for an empty URL without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveUserAvatarDisplayUrl('  ')).toEqual({ kind: 'none' });
    expect(await resolveUserAvatarDisplayUrl(null)).toEqual({ kind: 'none' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('purgeRetiredAvatarCache', () => {
  it('deletes the bucket this module no longer writes', async () => {
    const deleteSpy = vi.fn(async () => true);
    vi.stubGlobal('caches', { delete: deleteSpy });

    await purgeRetiredAvatarCache();

    expect(deleteSpy).toHaveBeenCalledWith('canari-user-avatars-v1');
  });

  it('says so and carries on when the bucket cannot be deleted', async () => {
    vi.stubGlobal('caches', {
      delete: async () => {
        throw new Error('quota');
      },
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await expect(purgeRetiredAvatarCache()).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
  });
});

describe('a known absence', () => {
  afterEach(() => vi.useRealTimers());

  it('is asked ONCE across remounts, and never again on a clock - only the session ending clears it', async () => {
    // HAR 2026-10-05: 7 users without a photo were asked 11-12 times each in 22 s.
    vi.useFakeTimers();
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);

    for (let i = 0; i < 12; i++) {
      expect(await resolveUserAvatarDisplayUrl(url, 'u')).toEqual({ kind: 'none' });
      releaseUserAvatarDisplayUrl(url);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // No timer expires an absence: a day later it is still believed.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await resolveUserAvatarDisplayUrl(url, 'u');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is never remembered for an outage - a 502 says nothing about whether there is a photo', async () => {
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchSpy);
    await resolveUserAvatarDisplayUrl(url, 'u');
    await resolveUserAvatarDisplayUrl(url, 'u');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('is forgotten when the signed-in reader changes', async () => {
    const { forgetReaderCaches } = await import('./sharedCache');
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    await resolveUserAvatarDisplayUrl(url, 'u');
    forgetReaderCaches();
    await resolveUserAvatarDisplayUrl(url, 'u');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
