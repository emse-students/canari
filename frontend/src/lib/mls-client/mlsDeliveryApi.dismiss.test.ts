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
    const api = makeApi(async () => Response.json({ status: 'dismissed' }, { status: 201 }));
    await expect(api.dismissGroup('g1')).resolves.toBeUndefined();
    await expect(api.undismissGroup('g1')).resolves.toBeUndefined();
  });

  it('throw a typed refusal carrying the status', async () => {
    const api = makeApi(async () => new Response('nope', { status: 403 }));
    await expect(api.dismissGroup('g1')).rejects.toMatchObject({ status: 403, code: null });
    await expect(api.undismissGroup('g1')).rejects.toMatchObject({ status: 403, code: null });
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
  it('returns the list it was answered', async () => {
    const api = makeApi(async () => Response.json(['g1', 7, 'g2']));
    expect(await api.getDismissedGroups()).toEqual({ kind: 'listed', groupIds: ['g1', 'g2'] });
  });

  /**
   * The read is started alongside the group list and consulted only when that list may be
   * believed, so it must not speak for itself: a dead-link boot would warn about a list nothing
   * reads. It CLASSIFIES, and discovery says the failure where it uses the list.
   */
  it('classifies a refusal and a transport failure, and logs neither itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusing = makeApi(async () => new Response('boom', { status: 500 }));
    expect(await refusing.getDismissedGroups()).toEqual({ kind: 'refused', status: 500 });
    const unreachable = makeApi(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await unreachable.getDismissedGroups()).toMatchObject({ kind: 'failed' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
