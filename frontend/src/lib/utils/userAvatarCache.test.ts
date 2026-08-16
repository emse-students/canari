/**
 * ONE REQUEST PER AVATAR, AND NONE AT ALL FOR A FACE WE HAVE ALREADY BEEN TOLD DOES NOT EXIST.
 *
 * The defect this pins was invisible in the UI: a miss returned the HTTP URL, the caller handed it
 * to an `<img>`, and the server was asked a second time for the answer it had just given. Nothing
 * looked wrong - initials appeared either way - while every account without a photo doubled the
 * outbound traffic of every list it appeared in, on every mount. That amplification is what turns a
 * single transient upstream fault into a burst of failures instead of one line.
 *
 * So the assertion is on the KIND, not on the pixels: `none` is what stops the second request, and
 * `direct` is what keeps the native clients working where `fetch` is refused and an element is not.
 */
import { resolveUserAvatarDisplayUrl, releaseUserAvatarDisplayUrl } from './userAvatarCache';

const URL_A = 'https://canari-emse.fr/api/users/aaaa/avatar';

/** A Cache API that starts empty and records what is stored in it. */
function installCaches() {
  const store = new Map<string, Response>();
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (k: string) => store.get(k),
      put: async (k: string, v: Response) => void store.set(k, v),
    }),
  });
  return store;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Blob URLs are created by the happy path; jsdom has no implementation.
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
  );
});

describe('resolveUserAvatarDisplayUrl', () => {
  it('asks once and reports `none` when the server says there is no avatar', async () => {
    installCaches();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveUserAvatarDisplayUrl(URL_A)).toEqual({ kind: 'none' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stores the bytes and answers `blob` when there is one', async () => {
    const store = installCaches();
    vi.stubGlobal('fetch', async () => new Response(new Blob(['img']), { status: 200 }));

    const first = await resolveUserAvatarDisplayUrl(URL_A);
    expect(first.kind).toBe('blob');
    expect(store.has(URL_A)).toBe(true);
    releaseUserAvatarDisplayUrl(URL_A);
  });

  it('falls back to the element - loudly - only when it could not ask at all', async () => {
    installCaches();
    // A cross-origin refusal: `fetch` throws where an `<img>` would still render. That is a
    // different question, not a retry of this one, which is why it is `direct` and not `none`.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    expect(await resolveUserAvatarDisplayUrl(URL_A)).toEqual({ kind: 'direct', url: URL_A });
    expect(debug).toHaveBeenCalled();
  });

  it('leaves it to the element where there is no Cache API to read', async () => {
    vi.stubGlobal('caches', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveUserAvatarDisplayUrl(URL_A)).toEqual({ kind: 'direct', url: URL_A });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers `none` for an empty URL without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveUserAvatarDisplayUrl('  ')).toEqual({ kind: 'none' });
    expect(await resolveUserAvatarDisplayUrl(null)).toEqual({ kind: 'none' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
