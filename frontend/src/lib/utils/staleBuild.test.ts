import { describe, expect, it, vi } from 'vitest';

import {
  STALE_BUILD_RELOADED_FOR_KEY,
  createStaleBuildRecovery,
  judgeStaleBuild,
  readServedVersion,
  type StaleBuildDeps,
} from './staleBuild';

/** A `Storage` over a map, with a switch that makes every access throw. */
function fakeStorage(): Storage & { denied: boolean; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const guard = <T>(fn: () => T): T => {
    if (store.denied) throw new DOMException('denied', 'SecurityError');
    return fn();
  };
  const store = {
    denied: false,
    raw,
    getItem: (k: string) => guard(() => raw.get(k) ?? null),
    setItem: (k: string, v: string) => guard(() => void raw.set(k, v)),
    removeItem: (k: string) => guard(() => void raw.delete(k)),
    clear: () => guard(() => raw.clear()),
    key: (i: number) => [...raw.keys()][i] ?? null,
    get length() {
      return raw.size;
    },
  };
  return store;
}

/** A fetch answering `version.json` with `served`, or failing when `served` is an Error. */
function versionFetch(served: string | Error | { status: number }): typeof fetch {
  return vi.fn(async () => {
    if (served instanceof Error) throw served;
    if (typeof served === 'object') return new Response('', { status: served.status });
    return new Response(JSON.stringify({ version: served }), { status: 200 });
  }) as unknown as typeof fetch;
}

function deps(overrides: Partial<StaleBuildDeps> = {}): StaleBuildDeps & {
  reload: ReturnType<typeof vi.fn>;
  confirmReload: ReturnType<typeof vi.fn>;
} {
  return {
    runningVersion: 'old',
    versionUrl: '/_app/version.json',
    fetchFn: versionFetch('new'),
    storage: fakeStorage(),
    confirmReload: vi.fn(async () => true),
    reload: vi.fn(),
    ...overrides,
  } as StaleBuildDeps & {
    reload: ReturnType<typeof vi.fn>;
    confirmReload: ReturnType<typeof vi.fn>;
  };
}

describe('judgeStaleBuild', () => {
  it('offers a reload when the server serves another build', () => {
    expect(judgeStaleBuild('old', 'new', null)).toEqual({
      kind: 'offer-reload',
      servedVersion: 'new',
    });
  });

  it('refuses to offer the same reload twice for one build', () => {
    expect(judgeStaleBuild('old', 'new', 'new')).toEqual({
      kind: 'already-reloaded',
      servedVersion: 'new',
    });
  });

  it('offers again for a NEWER deploy than the one already reloaded toward', () => {
    expect(judgeStaleBuild('old', 'newer', 'new').kind).toBe('offer-reload');
  });

  it('calls a failure on the served build itself not a deploy', () => {
    expect(judgeStaleBuild('same', 'same', null)).toEqual({ kind: 'same-build' });
  });

  it('makes no decision when the served build is unknown', () => {
    expect(judgeStaleBuild('old', null, null)).toEqual({ kind: 'unknown' });
  });
});

describe('readServedVersion', () => {
  it('reads the version, bypassing every cache', async () => {
    const fetchFn = versionFetch('abc');
    await expect(readServedVersion(fetchFn, '/_app/version.json')).resolves.toBe('abc');
    expect(fetchFn).toHaveBeenCalledWith('/_app/version.json', { cache: 'no-store' });
  });

  it('answers null on a refusal, a transport failure or a body without a version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readServedVersion(versionFetch({ status: 502 }), '/v')).resolves.toBeNull();
    await expect(
      readServedVersion(versionFetch(new TypeError('offline')), '/v')
    ).resolves.toBeNull();
    const noVersion = vi.fn(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    await expect(readServedVersion(noVersion, '/v')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe('createStaleBuildRecovery', () => {
  it('offers a reload and records the build it reloads toward BEFORE reloading', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    d.reload.mockImplementation(() => {
      expect((d.storage as Storage).getItem(STALE_BUILD_RELOADED_FOR_KEY)).toBe('new');
    });
    await expect(createStaleBuildRecovery(d).onPreloadError(new Error('x'))).resolves.toEqual({
      kind: 'offer-reload',
      servedVersion: 'new',
    });
    expect(d.confirmReload).toHaveBeenCalledTimes(1);
    expect(d.reload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('does not reload when the reader declines, and records nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps({ confirmReload: vi.fn(async () => false) });
    await createStaleBuildRecovery(d).onPreloadError(new Error('x'));
    expect(d.reload).not.toHaveBeenCalled();
    expect((d.storage as Storage).getItem(STALE_BUILD_RELOADED_FOR_KEY)).toBeNull();
    vi.restoreAllMocks();
  });

  it('never loops: a reloaded page still on the old build is not offered the same reload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = fakeStorage();
    storage.setItem(STALE_BUILD_RELOADED_FOR_KEY, 'new');
    const d = deps({ storage });
    await expect(createStaleBuildRecovery(d).onPreloadError(new Error('x'))).resolves.toEqual({
      kind: 'already-reloaded',
      servedVersion: 'new',
    });
    expect(d.confirmReload).not.toHaveBeenCalled();
    expect(d.reload).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('holds the guard in memory when sessionStorage is denied', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = fakeStorage();
    storage.denied = true;
    const d = deps({ storage });
    const recovery = createStaleBuildRecovery(d);
    await recovery.onPreloadError(new Error('x'));
    expect(d.reload).toHaveBeenCalledTimes(1);
    // The reload did not happen (still this page): the second failure must not offer it again.
    await expect(recovery.onPreloadError(new Error('y'))).resolves.toMatchObject({
      kind: 'already-reloaded',
    });
    expect(d.confirmReload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('offers nothing when the failure is on the served build or the served build is unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const same = deps({ fetchFn: versionFetch('old') });
    await expect(createStaleBuildRecovery(same).onPreloadError(new Error('x'))).resolves.toEqual({
      kind: 'same-build',
    });
    const offline = deps({ fetchFn: versionFetch(new TypeError('offline')) });
    await expect(createStaleBuildRecovery(offline).onPreloadError(new Error('x'))).resolves.toEqual(
      {
        kind: 'unknown',
      }
    );
    for (const d of [same, offline]) {
      expect(d.confirmReload).not.toHaveBeenCalled();
      expect(d.reload).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
  });

  it('asks once for failures that arrive together', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps();
    const recovery = createStaleBuildRecovery(d);
    await Promise.all([
      recovery.onPreloadError(new Error('chunk')),
      recovery.onPreloadError(new Error('its dependency')),
    ]);
    expect(d.fetchFn).toHaveBeenCalledTimes(1);
    expect(d.confirmReload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
