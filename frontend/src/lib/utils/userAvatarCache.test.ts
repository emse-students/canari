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
 * cache, and only it, decides whether that question reaches the network.
 */
import {
  resolveUserAvatarDisplayUrl,
  releaseUserAvatarDisplayUrl,
  purgeRetiredAvatarCache,
} from './userAvatarCache';

/** A fresh URL per test: the module holds live blobs keyed by URL, so tests must not share one. */
let urlCounter = 0;
function nextUrl(): string {
  return `https://canari-emse.fr/api/users/u${++urlCounter}/avatar`;
}

let revoked: string[] = [];

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('asks the server again for a face nothing is displaying any more', async () => {
    // THE STALE-AVATAR REGRESSION. The old bucket answered the second mount from disk, for ever,
    // so a photo changed upstream never reached a device that had already drawn the old one.
    // Whether this second question costs a network round trip is the HTTP cache's decision, made
    // from the `max-age` the server sent - one lifetime, stated by the only party that knows it.
    const url = nextUrl();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const first = await resolveUserAvatarDisplayUrl(url);
    releaseUserAvatarDisplayUrl(url);
    const second = await resolveUserAvatarDisplayUrl(url);
    releaseUserAvatarDisplayUrl(url);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(first).not.toEqual(second);
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
    expect(revoked).toEqual([]);
    releaseUserAvatarDisplayUrl(url);
    expect(revoked).toEqual([a.kind === 'blob' ? a.url : '']);
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
