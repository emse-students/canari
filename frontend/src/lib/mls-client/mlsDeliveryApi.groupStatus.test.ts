import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * `getGroupServerStatus` doit distinguer un groupe ABSENT (purge legitime) d'une vraie ERREUR
 * reseau (doute -> on conserve). Piege specifique du backend : `GET mls/groups/:id` renvoie le
 * `null` du handler sous forme d'un CORPS VIDE (200) -> `res.json()` jette. Sans le fix, ce cas
 * etait classe 'error' ("statut incertain") et la conversation supprimee n'etait jamais purgee.
 */
function makeApi(fetchImpl: MlsDeliveryFetch): MlsDeliveryApi {
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

function response(body: string, init: { status?: number }): Response {
  return new Response(body, { status: init.status ?? 200 });
}

describe('getGroupServerStatus', () => {
  it("corps vide sur 200 (handler a renvoye null) -> 'absent'", async () => {
    const api = makeApi(async () => response('', { status: 200 }));
    expect(await api.getGroupServerStatus('g1')).toBe('absent');
  });

  it('corps "null" litteral sur 200 -> \'absent\'', async () => {
    const api = makeApi(async () => response('null', { status: 200 }));
    expect(await api.getGroupServerStatus('g1')).toBe('absent');
  });

  it("404 -> 'absent' (aucune ligne dm_groups)", async () => {
    const api = makeApi(async () => response('Not Found', { status: 404 }));
    expect(await api.getGroupServerStatus('g1')).toBe('absent');
  });

  it("500 -> 'error' (doute reel, on ne purge pas)", async () => {
    const api = makeApi(async () => response('boom', { status: 500 }));
    expect(await api.getGroupServerStatus('g1')).toBe('error');
  });

  it("fetch rejette (reseau coupe) -> 'error'", async () => {
    const api = makeApi(async () => {
      throw new Error('network down');
    });
    expect(await api.getGroupServerStatus('g1')).toBe('error');
  });

  it('groupe existant -> GroupMeta (avec deletedAt pour un tombstone)', async () => {
    const api = makeApi(async () =>
      response(
        JSON.stringify({
          id: 'g1',
          name: 'Equipe',
          isGroup: true,
          deletedAt: null,
        }),
        { status: 200 }
      )
    );
    const status = await api.getGroupServerStatus('g1');
    expect(status).toMatchObject({ groupId: 'g1', name: 'Equipe', isGroup: true, deletedAt: null });
  });
});
