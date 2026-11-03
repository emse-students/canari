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
 *
 * Since the signed avatar URL (2026-11-02) every key is the USER ID: the URL carries the viewer's
 * avatar token, which rotates, and must never split one face in two.
 */
import {
  resolveUserAvatarDisplay,
  releaseUserAvatarDisplay,
  purgeRetiredAvatarCache,
  AVATAR_WARM_MS,
  AVATAR_POOL_MAX_ENTRIES,
} from './userAvatarCache';
import { mirrorAvatarToNative } from './avatarMirror';
import { avatarUrl, setAvatarToken } from './avatarUrl';

vi.mock('./avatarMirror', () => ({ mirrorAvatarToNative: vi.fn(async () => {}) }));
// "Nobody could say" unless a test states otherwise: the avatar is then requested, as before the
// presence answer existed - which is what every test below the presence one measures.
const presence = vi.fn<(userId: string) => Promise<boolean | null>>(async () => null);
vi.mock('./avatarPresence', () => ({ avatarPhotoPresence: (id: string) => presence(id) }));

/** A fresh user per test: the module holds live blobs keyed by user, so tests must not share one. */
let userCounter = 0;
function nextUser(): string {
  return `user-${++userCounter}`;
}

let revoked: string[] = [];

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAvatarToken(null);
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

describe('resolveUserAvatarDisplay', () => {
  it('hands the bytes of a load to the notification cache once, under the id it was given', async () => {
    const mirror = vi.mocked(mirrorAvatarToNative);
    mirror.mockClear();
    const user = nextUser();
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));

    await Promise.all([resolveUserAvatarDisplay(user), resolveUserAvatarDisplay(user)]);
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mock.calls[0][0]).toBe(user);
    releaseUserAvatarDisplay(user);
    releaseUserAvatarDisplay(user);

    // An absence is not a face.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await resolveUserAvatarDisplay(nextUser());
    expect(mirror).toHaveBeenCalledTimes(1);
  });

  it("asks the URL the ONE helper builds, carrying the viewer's avatar token", async () => {
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    setAvatarToken('sid.mac');

    await resolveUserAvatarDisplay(user);
    releaseUserAvatarDisplay(user);

    const asked = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(asked).toBe(avatarUrl(user));
    expect(asked).toMatch(/\/api\/users\/user-\d+\/avatar\?t=sid\.mac$/);
  });

  // Mi 9T, 2026-10-13: 25 refused avatar requests in one salon open. The list's presence answer
  // says which faces exist, and a face without one is never requested.
  it('requests nothing for a face the presence answer says has no photo, and remembers it', async () => {
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    presence.mockResolvedValueOnce(false);

    expect(await resolveUserAvatarDisplay(user)).toEqual({ kind: 'none' });
    expect(await resolveUserAvatarDisplay(user)).toEqual({ kind: 'none' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests a face the presence answer says has a photo', async () => {
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    presence.mockResolvedValueOnce(true);

    expect((await resolveUserAvatarDisplay(user)).kind).toBe('blob');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    releaseUserAvatarDisplay(user);
  });

  it('asks once and reports `none` when the server says there is no avatar', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveUserAvatarDisplay(nextUser())).toEqual({ kind: 'none' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('answers `blob` without writing anything to Cache Storage', async () => {
    const user = nextUser();
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));
    // A bucket that fails loudly if it is opened at all: keeping avatars across sessions is
    // EXACTLY the defect, so the assertion is that this store is never touched.
    const open = vi.fn(() => {
      throw new Error('Cache Storage must never hold an avatar');
    });
    vi.stubGlobal('caches', { open, delete: async () => false });

    const first = await resolveUserAvatarDisplay(user);
    expect(first.kind).toBe('blob');
    expect(open).not.toHaveBeenCalled();
    releaseUserAvatarDisplay(user);
  });

  describe('the warm window', () => {
    afterEach(() => vi.useRealTimers());

    it('answers a remount inside the window from memory: no presence wait, no request', async () => {
      vi.useFakeTimers();
      const user = nextUser();
      const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      presence.mockClear();

      const first = await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);
      vi.advanceTimersByTime(AVATAR_WARM_MS - 1);
      const second = await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);

      expect(second).toEqual(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(presence).toHaveBeenCalledTimes(1);
      expect(revoked).toEqual([]);
    });

    it('keeps a warm face across a token rotation: the key is the person, not the URL', async () => {
      vi.useFakeTimers();
      const user = nextUser();
      const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      setAvatarToken('sid.day-one');
      const first = await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);
      setAvatarToken('sid.day-two');
      const second = await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);

      expect(second).toEqual(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('asks the server again once the window has passed, and revokes the old blob', async () => {
      // THE STALE-AVATAR GUARD. Staleness is bounded by this window and by nothing else here.
      vi.useFakeTimers();
      const user = nextUser();
      const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      const first = await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);
      vi.advanceTimersByTime(AVATAR_WARM_MS + 1);
      expect(revoked).toEqual([first.kind === 'blob' ? first.url : '']);
      const second = await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(first).not.toEqual(second);
    });

    it('never revokes a blob a mount still holds, however long it has been', async () => {
      vi.useFakeTimers();
      const user = nextUser();
      vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));
      await resolveUserAvatarDisplay(user);
      vi.advanceTimersByTime(AVATAR_WARM_MS * 10);
      expect(revoked).toEqual([]);
      releaseUserAvatarDisplay(user);
    });

    it('forgets the warm faces when the signed-in reader changes', async () => {
      vi.useFakeTimers();
      const { forgetReaderCaches } = await import('./sharedCache');
      const user = nextUser();
      const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);
      forgetReaderCaches();
      await resolveUserAvatarDisplay(user);
      releaseUserAvatarDisplay(user);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(revoked).toHaveLength(1);
    });

    it('is bounded: past the entry cap the idlest warm face is revoked', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));
      const first = nextUser();
      await resolveUserAvatarDisplay(first);
      releaseUserAvatarDisplay(first);
      for (let i = 0; i < AVATAR_POOL_MAX_ENTRIES; i++) {
        vi.advanceTimersByTime(1);
        const u = nextUser();
        await resolveUserAvatarDisplay(u);
        releaseUserAvatarDisplay(u);
      }
      expect(revoked).toHaveLength(1);
    });
  });

  it('costs one request when the same face mounts several times at once', async () => {
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(new Blob(['img']), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const [a, b, c] = await Promise.all([
      resolveUserAvatarDisplay(user),
      resolveUserAvatarDisplay(user),
      resolveUserAvatarDisplay(user),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);

    // Each of the three holds it: the blob survives until the last one lets go, and is revoked
    // exactly once. Releasing on the first unmount is what used to blank the two others.
    releaseUserAvatarDisplay(user);
    releaseUserAvatarDisplay(user);
    releaseUserAvatarDisplay(user);
    // The last release starts the warm window rather than revoking (see 'the warm window').
    expect(revoked).toEqual([]);
  });

  it('falls back to the element - loudly - only when it could not ask at all', async () => {
    const user = nextUser();
    // A cross-origin refusal: `fetch` throws where an `<img>` would still render. That is a
    // different question, not a retry of this one, which is why it is `direct` and not `none`.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    expect(await resolveUserAvatarDisplay(user)).toEqual({ kind: 'direct', url: avatarUrl(user) });
    expect(debug).toHaveBeenCalled();
  });

  it('never writes the URL - which carries the token - into a log line', async () => {
    setAvatarToken('sid.secret-mac');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await resolveUserAvatarDisplay(nextUser());
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await resolveUserAvatarDisplay(nextUser());
    const said = debug.mock.calls.flat().map(String).join('\n');
    expect(said).not.toContain('secret-mac');
  });

  it('draws avatars on a client that has no Cache Storage at all', async () => {
    const user = nextUser();
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));

    expect((await resolveUserAvatarDisplay(user)).kind).toBe('blob');
    releaseUserAvatarDisplay(user);
  });

  it('answers `none` for an empty id without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveUserAvatarDisplay('  ')).toEqual({ kind: 'none' });
    expect(await resolveUserAvatarDisplay(null)).toEqual({ kind: 'none' });
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
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);

    for (let i = 0; i < 12; i++) {
      expect(await resolveUserAvatarDisplay(user)).toEqual({ kind: 'none' });
      releaseUserAvatarDisplay(user);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // No timer expires an absence: a day later it is still believed.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await resolveUserAvatarDisplay(user);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is KEYED BY THE USER: a rotated avatar token does not split it and ask again', async () => {
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);

    setAvatarToken('sid.day-one');
    expect(await resolveUserAvatarDisplay(user)).toEqual({ kind: 'none' });
    setAvatarToken('sid.day-two');
    expect(await resolveUserAvatarDisplay(user)).toEqual({ kind: 'none' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is never remembered for an outage - a 502 says nothing about whether there is a photo', async () => {
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchSpy);
    await resolveUserAvatarDisplay(user);
    await resolveUserAvatarDisplay(user);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('is never remembered for a refused token - a 403 says nothing about the photo', async () => {
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchSpy);
    await resolveUserAvatarDisplay(user);
    await resolveUserAvatarDisplay(user);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('is forgotten when the signed-in reader changes', async () => {
    const { forgetReaderCaches } = await import('./sharedCache');
    const user = nextUser();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    await resolveUserAvatarDisplay(user);
    forgetReaderCaches();
    await resolveUserAvatarDisplay(user);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
