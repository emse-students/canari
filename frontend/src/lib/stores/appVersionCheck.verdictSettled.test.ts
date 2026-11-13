// @vitest-environment happy-dom
/**
 * WHETHER THE VERSION VERDICT HAS SETTLED - the fact the announcement waits for before it draws its
 * device copy (2026-11-11), so a below-minimum gate decided a moment later never has the modal
 * flash in front of it. `lastCheck` cannot say it: it stays `null` after a non-blocking verdict.
 */
export {};

vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy({}, { get: (_t, key) => () => String(key) }),
}));

const SERVER_INFO = {
  version: '0.0.0',
  minClientVersion: '0.0.0',
  maintenance: { enabled: false },
};

describe('isVersionVerdictSettled', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('is false while the check is on the wire, true once it answered', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)))
    );
    const mod = await import('./appVersionCheck.svelte');
    expect(mod.isVersionVerdictSettled()).toBe(false);

    const checking = mod.refreshAppVersionCheck();
    await Promise.resolve();
    expect(mod.isVersionVerdictSettled()).toBe(false);

    answer(
      new Response(JSON.stringify(SERVER_INFO), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await checking;
    expect(mod.isVersionVerdictSettled()).toBe(true);
  });
});
