import {
  MlsDeliveryApi,
  SelfConversationUnsupportedError,
  type MlsDeliveryFetch,
} from './mlsDeliveryApi';

/**
 * "MES NOTES" IS BELIEVED ONLY FROM THE SERVER'S OWN `kind`. A server older than migration 056
 * drops `kind: 'self'` and writes an ordinary group that seats every device; tagging that row as the
 * notes here would make the account's devices disagree about which group holds them
 * (legacy-compatibility.md, "Mes notes").
 */
function makeApi(fetchImpl: MlsDeliveryFetch): MlsDeliveryApi {
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

const GROUP = 'e4c1f0aa-0000-4000-8000-00000000005e';

describe('createRemoteGroup, kind self', () => {
  it('returns the group a server that knows the kind wrote as self', async () => {
    const api = makeApi(async () => Response.json({ groupId: GROUP, kind: 'self' }));
    await expect(api.createRemoteGroup(null, false, 'self')).resolves.toBe(GROUP);
  });

  it('throws the typed refusal, carrying the ordinary group, when the answer names no kind', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi(async () => Response.json({ groupId: GROUP, isGroup: false }));
    const refusal = await api.createRemoteGroup(null, false, 'self').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SelfConversationUnsupportedError);
    expect((refusal as SelfConversationUnsupportedError).groupId).toBe(GROUP);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('throws it too when the answer names another kind', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi(async () => Response.json({ groupId: GROUP, kind: 'conversation' }));
    await expect(api.createRemoteGroup(null, false, 'self')).rejects.toBeInstanceOf(
      SelfConversationUnsupportedError
    );
    error.mockRestore();
  });

  it('an ordinary creation does not read the kind at all', async () => {
    const api = makeApi(async () => Response.json({ groupId: GROUP }));
    await expect(api.createRemoteGroup('Club', true)).resolves.toBe(GROUP);
  });
});
