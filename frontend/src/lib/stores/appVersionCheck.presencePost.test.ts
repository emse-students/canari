// @vitest-environment happy-dom
/**
 * THE PRESENCE ROUTE IS KNOWN FROM THE CACHED `/api/version` ANSWER WHEN THE PROBE FAILS.
 *
 * `lastCheck` is adopted from the cache only for a blocking verdict, so a healthy cache plus one
 * probe that failed its whole ladder left `serverPresencePost()` at `null`, and `presenceStore.ts`
 * asked nothing until the next focus: presence went dark on a flaky link. The cache is written
 * through the module itself, so this test restates no storage format.
 */
export {};

// The paraglide barrel is the import cost and nothing here asserts a message (see
// appVersionCheck.importIsQuiet.test.ts).
vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy({}, { get: (_t, key) => () => String(key) }),
}));

/** A server older than any client build, so the verdict never blocks and is never adopted. */
const SERVER_INFO = {
  version: '0.0.0',
  minClientVersion: '0.0.0',
  maintenance: { enabled: false },
  presencePost: true,
};

describe('serverPresencePost', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('is not known before any server has answered this session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    const mod = await import('./appVersionCheck.svelte');
    expect(mod.serverPresencePost()).toBeNull();
  });

  it('probe failed, cache says presencePost true -> the POST route is known', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(SERVER_INFO), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    await (await import('./appVersionCheck.svelte')).refreshAppVersionCheck();

    // A reload: the module is fresh, the session cache is not, and the network is gone. The
    // import adopts a cached verdict only when it BLOCKS, and the offline refresh likewise - so
    // `lastCheck` stays null here, which is what left presence dark.
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    const mod = await import('./appVersionCheck.svelte');

    expect(mod.getAppVersionCheck()).toBeNull();
    expect(mod.serverPresencePost()).toBe(true);
  });
});
