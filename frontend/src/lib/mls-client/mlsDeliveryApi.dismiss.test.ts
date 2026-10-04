import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * The per-user dismiss is the ONLY thing that propagates a manual delete to the user's other
 * devices. It used to swallow its own failure, so the `.catch` that logs at every call site could
 * never fire and a lost dismissal left no trace at all. It now THROWS on a refusal and on a
 * transport failure, and the callers log.
 */
function makeApi(fetchImpl: MlsDeliveryFetch): MlsDeliveryApi {
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

describe('dismissGroup / undismissGroup', () => {
  it('resolve when the server answers 2xx', async () => {
    const api = makeApi(async () => new Response('{"status":"dismissed"}', { status: 201 }));
    await expect(api.dismissGroup('g1')).resolves.toBeUndefined();
    await expect(api.undismissGroup('g1')).resolves.toBeUndefined();
  });

  it('throw on a refusal, naming the status', async () => {
    const api = makeApi(async () => new Response('nope', { status: 403 }));
    await expect(api.dismissGroup('g1')).rejects.toThrow('HTTP 403');
    await expect(api.undismissGroup('g1')).rejects.toThrow('HTTP 403');
  });

  it('throw on a transport failure', async () => {
    const api = makeApi(async () => {
      throw new Error('network down');
    });
    await expect(api.dismissGroup('g1')).rejects.toThrow('network down');
    await expect(api.undismissGroup('g1')).rejects.toThrow('network down');
  });
});

describe('getDismissedGroups', () => {
  it('returns [] and SAYS so when the read fails - never purge on a doubt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi(async () => new Response('boom', { status: 500 }));
    expect(await api.getDismissedGroups()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('500'));
    warn.mockRestore();
  });
});
