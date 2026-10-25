import { MlsDeliveryApi, NotAGroupMemberError, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * `getGroupServerStatus` must distinguish an ABSENT group (legitimate purge) from a genuine
 * network ERROR (doubt -> keep it). 'absent' PURGES, so it is read only from the delivery
 * service's JSON: the handler answers `{ found: false }` for a missing row. A bare `null` used to
 * leave Nest as an empty untyped 200, which a captive portal can answer too.
 */
function makeApi(fetchImpl: MlsDeliveryFetch): MlsDeliveryApi {
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

/** The JSON content type the real server sends, unless a case is about a body that is not the API's. */
function response(body: string, init: { status?: number; contentType?: string | null }): Response {
  const type = init.contentType === undefined ? 'application/json' : init.contentType;
  return new Response(body, {
    status: init.status ?? 200,
    headers: type === null ? {} : { 'content-type': type },
  });
}

describe('getGroupServerStatus', () => {
  it("the server's { found: false } on 200 -> 'absent'", async () => {
    const api = makeApi(async () => response('{"found":false}', { status: 200 }));
    expect(await api.getGroupServerStatus('g1')).toBe('absent');
  });

  it("a captive portal's 200 text/html -> 'error', never a purge", async () => {
    const api = makeApi(async () =>
      response('<html>Sign in to use this network</html>', {
        status: 200,
        contentType: 'text/html',
      })
    );
    expect(await api.getGroupServerStatus('g1')).toBe('error');
  });

  it("an empty untyped 200 -> 'error': it cannot be told from a portal's, so it never purges", async () => {
    const api = makeApi(async () => response('', { status: 200, contentType: null }));
    expect(await api.getGroupServerStatus('g1')).toBe('error');
  });

  it("a JSON type whose body does not parse -> 'error'", async () => {
    const api = makeApi(async () => response('{"half', { status: 200 }));
    expect(await api.getGroupServerStatus('g1')).toBe('error');
  });

  it('corps "null" litteral sur 200 -> \'absent\'', async () => {
    const api = makeApi(async () => response('null', { status: 200 }));
    expect(await api.getGroupServerStatus('g1')).toBe('absent');
  });

  // THE HANDLER NEVER ANSWERS 404 (a missing row is `{ found: false }`), so a 404 is an edge, a
  // portal or a misrouted deploy - and a route-level 404 would purge EVERY group at once.
  it.each([
    ['plain text', 'text/plain'],
    ['JSON', 'application/json'],
  ])("a 404 (%s) -> 'error', never a purge", async (_label, contentType) => {
    const api = makeApi(async () => response('Not Found', { status: 404, contentType }));
    expect(await api.getGroupServerStatus('g1')).toBe('error');
  });

  it("500 -> 'error' (doute reel, on ne purge pas)", async () => {
    const api = makeApi(async () => response('boom', { status: 500 }));
    expect(await api.getGroupServerStatus('g1')).toBe('error');
  });

  // ONLY THE 404 ACCUSES (the handler never sends one). A 5xx or a portal answers every group of a
  // sweep alike, so it stays at debug and the sweep says it once (`discoverMissingGroups`).
  it('warns on a 404 only; a 5xx and a portal 200 are debug lines', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await makeApi(async () => response('boom', { status: 502 })).getGroupServerStatus('g1');
      await makeApi(async () =>
        response('<html>portal</html>', { status: 200, contentType: 'text/html' })
      ).getGroupServerStatus('g1');
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(2);
      await makeApi(async () =>
        response('Not Found', { status: 404, contentType: 'text/plain' })
      ).getGroupServerStatus('g1');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('never sends'));
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
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
  // The REAL body: `assertCallerIsGroupMember` throws `refusalBody(NOT_A_MEMBER, ...)`, which Nest
  // serialises as `{ code, message }` alone - no `statusCode`. An envelope-only reading missed it,
  // and a removed member kept the conversation.
  it('raises a typed refusal on the coded 403 the route really sends, carrying the group', async () => {
    const api = makeApi(async () =>
      response('{"code":"NOT_A_MEMBER","message":"Caller is not a member of this group"}', {
        status: 403,
      })
    );

    const err = await api.getGroupMembers('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotAGroupMemberError);
    expect((err as NotAGroupMemberError).groupId).toBe('g1');
  });

  it("a 403 whose code is not the contract's is no membership answer", async () => {
    const api = makeApi(async () =>
      response('{"code":"ACCESS_DENIED","message":"blocked"}', { status: 403 })
    );

    const err = await api.getGroupMembers('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
  });

  it('a JSON-speaking CDN 403 is no membership answer', async () => {
    const api = makeApi(async () =>
      response(
        '{"type":"https://developers.cloudflare.com/x","title":"Access denied","status":403,' +
          '"detail":"blocked","error_code":1020}',
        { status: 403 }
      )
    );

    const err = await api.getGroupMembers('g1').catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
  });

  // The gateway's own error pages imitate Nest's envelope for 5xx: a gateway origin, but a status
  // that says nothing about membership.
  it('an envelope-imitating 502 is no membership answer', async () => {
    const api = makeApi(async () =>
      response('{"statusCode":502,"message":"Bad Gateway"}', { status: 502 })
    );

    const err = await api.getGroupMembers('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
  });

  it("an edge's HTML 403 is no membership answer", async () => {
    const api = makeApi(async () =>
      response('<html>Access denied</html>', { status: 403, contentType: 'text/html' })
    );

    const err = await api.getGroupMembers('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
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
  // `messaging.service.ts` throws `ForbiddenException(string)` here, so this one IS the envelope.
  it('raises a typed refusal on 403, carrying the group', async () => {
    const api = makeApi(async () =>
      response('{"statusCode":403,"message":"User u is not a member of group g1"}', {
        status: 403,
      })
    );

    const err = await api.fetchGroupInfo('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotAGroupMemberError);
    expect((err as NotAGroupMemberError).groupId).toBe('g1');
  });

  it("an edge's HTML 403 is no membership answer", async () => {
    const api = makeApi(async () =>
      response('<html>Access denied</html>', { status: 403, contentType: 'text/html' })
    );

    const err = await api.fetchGroupInfo('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
  });

  it('a JSON-speaking edge 403 (no Nest envelope) is no membership answer either', async () => {
    const api = makeApi(async () =>
      response('{"status":403,"title":"Access denied"}', { status: 403 })
    );

    const err = await api.fetchGroupInfo('g1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAGroupMemberError);
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
