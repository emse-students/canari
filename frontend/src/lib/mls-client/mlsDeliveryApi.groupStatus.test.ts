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
});

/**
 * THE SAME REFUSAL, ON THE ENDPOINT WHERE MISREADING IT COST A LOOP. `GET mls/group-info/:id` is
 * gated on a `dm_group_members` row (`messaging.service.ts` throws `ForbiddenException` when there
 * is none), so its 403 is the server answering the exact question the recovery seam asks. Until it
 * was typed, `externalJoin` flattened it into the same `null` as "nothing published yet" - the one
 * state whose correct response is to try again - so a group we had LEFT was chased once a minute,
 * with a 403 and a broadcast asking to be re-added, terminating only if somebody deleted the group.
 *
 * The negative cases are half the point: a 503 read as "not a member" would retire live
 * conversations on a bad deploy, which is a worse failure than the one being fixed.
 */
describe('fetchGroupInfo - a refused base is a membership answer', () => {
  it('raises a typed refusal on 403, carrying the group', async () => {
    const api = makeApi(async () =>
      response('{"message":"User u is not a member of group g1"}', { status: 403 })
    );

    const err = await api.fetchGroupInfo('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotAGroupMemberError);
    expect((err as NotAGroupMemberError).groupId).toBe('g1');
  });

  it.each([401, 404, 500, 502, 503])('leaves %i unclassified', async (status) => {
    const api = makeApi(async () => response('{}', { status }));

    const err = await api.fetchGroupInfo('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
  });

  // NOT THE SAME THING AS A REFUSAL, and keeping the two apart is the whole fix: a member whose
  // group has no base published yet gets a 200 and a null body, and that caller SHOULD retry.
  it('returns null on 200 with nothing stored', async () => {
    const api = makeApi(async () => response('null', { status: 200 }));

    expect(await api.fetchGroupInfo('g1')).toBeNull();
  });

  it('returns the stored base on 200', async () => {
    const api = makeApi(async () =>
      response('{"groupInfo":"Z2k=","baseEpoch":7,"activeEpoch":7}', { status: 200 })
    );

    expect(await api.fetchGroupInfo('g1')).toEqual({
      groupInfo: 'Z2k=',
      baseEpoch: 7,
      activeEpoch: 7,
    });
  });

  // THE FACT THAT REPLACES A DOOMED ROUND TRIP (COMM-8, production 2026-08-25). A base behind the
  // group's epoch is refused by the commit gate every time, so the joiner has to be able to read
  // that here rather than learn it by building a tree and being told no.
  it('carries a base the group has outrun as two numbers', async () => {
    const api = makeApi(async () =>
      response('{"groupInfo":"Z2k=","baseEpoch":3,"activeEpoch":6}', { status: 200 })
    );

    expect(await api.fetchGroupInfo('g1')).toEqual({
      groupInfo: 'Z2k=',
      baseEpoch: 3,
      activeEpoch: 6,
    });
  });

  it('reads a missing active epoch as the base, never as zero', async () => {
    // An older delivery build does not send the field. Defaulting to 0 would mark EVERY base ahead
    // of its group and refuse every join; the base itself means "nothing known to be stale".
    const api = makeApi(async () =>
      response('{"groupInfo":"Z2k=","baseEpoch":7}', { status: 200 })
    );

    expect(await api.fetchGroupInfo('g1')).toEqual({
      groupInfo: 'Z2k=',
      baseEpoch: 7,
      activeEpoch: 7,
    });
  });

  // An empty list is a genuine answer and must not be confused with a refusal.
  it('returns an empty list on a 200 with no member', async () => {
    const api = makeApi(async () => response('[]', { status: 200 }));

    expect(await api.getGroupMembers('g1')).toEqual([]);
  });
});
