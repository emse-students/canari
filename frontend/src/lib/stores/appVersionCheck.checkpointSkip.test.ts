// @vitest-environment happy-dom
/**
 * THE CHECKPOINT-SKIP SWITCH IS `off` UNTIL A SERVER SAYS `on`, AND A SAID `on` IS HEARD.
 *
 * `serverCheckpointSkipMode()` is read by the MLS state persister at every drain end. Before any
 * answer it must be `off` - today's durability - and once an answer said `on`, only the live answer
 * of THIS process carries it - never the session's cached copy, which would let a cached `on`
 * outlive an emergency `off`.
 */
export {};

// The paraglide barrel is the import cost and nothing here asserts a message (see
// appVersionCheck.importIsQuiet.test.ts).
vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy({}, { get: (_t, key) => () => String(key) }),
}));

/** A server older than any client build, so the verdict never blocks. */
function serverInfo(mode: unknown) {
  return {
    version: '0.0.0',
    minClientVersion: '0.0.0',
    maintenance: { enabled: false },
    checkpointSkip: { mode },
  };
}

function answering(body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('serverCheckpointSkipMode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('is off before any server has answered this session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    const mod = await import('./appVersionCheck.svelte');
    expect(mod.serverCheckpointSkipMode()).toBe('off');
  });

  it('follows the live answer, both ways', async () => {
    vi.stubGlobal('fetch', answering(serverInfo('on')));
    const mod = await import('./appVersionCheck.svelte');
    await mod.refreshAppVersionCheck();
    expect(mod.serverCheckpointSkipMode()).toBe('on');

    vi.stubGlobal('fetch', answering(serverInfo('off')));
    await mod.refreshAppVersionCheck();
    expect(mod.serverCheckpointSkipMode()).toBe('off');
  });

  it('reads an older server, which publishes no switch, as off', async () => {
    const { checkpointSkip: _absent, ...older } = serverInfo('on');
    vi.stubGlobal('fetch', answering(older));
    const mod = await import('./appVersionCheck.svelte');
    await mod.refreshAppVersionCheck();
    expect(mod.serverCheckpointSkipMode()).toBe('off');
  });

  it('probe failed, cache says on -> OFF: only a live answer of this process turns the skip on', async () => {
    vi.stubGlobal('fetch', answering(serverInfo('on')));
    await (await import('./appVersionCheck.svelte')).refreshAppVersionCheck();

    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    const mod = await import('./appVersionCheck.svelte');

    expect(mod.getAppVersionCheck()).toBeNull();
    expect(mod.serverCheckpointSkipMode()).toBe('off');
    // An offline refresh adopts the cache for its verdict, never for the switch.
    await mod.refreshAppVersionCheck();
    expect(mod.serverCheckpointSkipMode()).toBe('off');
  });
});
