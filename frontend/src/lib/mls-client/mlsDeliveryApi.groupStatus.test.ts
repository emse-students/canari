import { MlsDeliveryApi, NotAGroupMemberError, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * `getGroupServerStatus` must distinguish an ABSENT group (legitimate purge) from a genuine
 * network ERROR (doubt -> keep it). Backend-specific trap: `GET mls/groups/:id` returns the
 * handler's `null` as an EMPTY BODY (200) -> `res.json()` throws. Without the fix, that case was
 * classified 'error' ("uncertain status") and the deleted conversation was never purged.
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

/**
 * THE 403 THIS ENDPOINT ANSWERS IS A FACT, NOT A FAULT. `GET mls/groups/:id/members` is
 * members-only by design (audit S5), so a caller asking "am I still a member" is refused precisely
 * when the answer is no. Typing that refusal is what lets `verifyCurrentUserMembership` tell it
 * apart from an outage - which it could not do while every failure was one `catch` answering `true`.
 */
describe('getGroupMembers - a status code is an answer, a transport failure is not', () => {
  it('raises a typed refusal on 403, carrying the group', async () => {
    const api = makeApi(async () =>
      response('{"message":"Caller is not a member"}', { status: 403 })
    );

    const err = await api.getGroupMembers('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotAGroupMemberError);
    expect((err as NotAGroupMemberError).groupId).toBe('g1');
  });

  // Every other non-2xx says NOTHING about membership, so none of them may be mistaken for one.
  // A 500 read as "not a member" would retire live conversations on a bad deploy.
  it.each([401, 404, 500, 502])('leaves %i unclassified', async (status) => {
    const api = makeApi(async () => response('{}', { status }));

    const err = await api.getGroupMembers('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
  });

  it('returns the member list on 200', async () => {
    const api = makeApi(async () => response('[{"userId":"u1","deviceId":"d1"}]', { status: 200 }));

    expect(await api.getGroupMembers('g1')).toEqual([{ userId: 'u1', deviceId: 'd1' }]);
  });

  // An empty list is a genuine answer and must not be confused with a refusal.
  it('returns an empty list on a 200 with no member', async () => {
    const api = makeApi(async () => response('[]', { status: 200 }));

    expect(await api.getGroupMembers('g1')).toEqual([]);
  });
});
