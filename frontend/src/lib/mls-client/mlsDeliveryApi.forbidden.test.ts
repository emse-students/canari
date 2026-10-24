import { describe, expect, it, vi } from 'vitest';
import {
  AwaitingAdmissionError,
  ExclusionsRefusedError,
  MlsDeliveryApi,
  NotAGroupMemberError,
  SendEdgeRefusedError,
  SendForbiddenError,
  SenderNotActiveError,
  SendServerError,
  parseRetryAfterMs,
  WithheldUnsupportedError,
} from './mlsDeliveryApi';
import { classifyOutgoingSendError } from './mlsSendError';
import { refusalStatus } from '$lib/utils/apiRefusal';

/**
 * A 403 ON A SEND IS CLASSIFIED AT THE THROW. `sender_not_active` keeps its own type (a Welcome
 * lifts it); every other 403 is the caller refused outright (`AUTHZ FAIL caller != requester`,
 * measured 2026-10-10) and carries its status as a field, so the outbox reads the type.
 */
describe('postApplicationMessage on a 403', () => {
  const api = (res: Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });

  it('raises SendForbiddenError carrying status 403 for an authorization refusal', async () => {
    const failure = await api(
      new Response(JSON.stringify({ message: 'requesterUserId does not match' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SendForbiddenError);
    expect(refusalStatus(failure)).toBe(403);
  });

  it('keeps sender_not_active as its own type', async () => {
    const failure = await api(
      new Response(JSON.stringify({ error: 'sender_not_active', status: 'pending' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SenderNotActiveError);
    expect(failure).not.toBeInstanceOf(SendForbiddenError);
  });

  it('classifies an HTML 403 (CrowdSec ban page) as an edge refusal, not an identity one', async () => {
    const failure = await api(
      new Response('<html><title>CrowdSec Ban</title></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SendEdgeRefusedError);
    expect(failure).not.toBeInstanceOf(SendForbiddenError);
    expect(refusalStatus(failure)).toBeNull();
  });
});

/**
 * A 5xx ON A SEND IS TYPED AT THE THROW (user, 2026-10-18): the outbox counts it by TYPE toward
 * parking a text as failed, and any other status is an answer carried as a field, never a sentence.
 */
describe('postApplicationMessage on a 5xx or another status', () => {
  const api = (res: Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });

  it('raises SendServerError with its status and WHO answered', async () => {
    const gateway = await api(
      new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);
    const edge = await api(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(gateway).toBeInstanceOf(SendServerError);
    expect((gateway as SendServerError).origin).toBe('gateway');
    expect(refusalStatus(gateway)).toBe(500);
    expect(edge).toBeInstanceOf(SendServerError);
    expect((edge as SendServerError).origin).toBe('edge');
    expect(classifyOutgoingSendError(edge)).toBe('unknown');
  });

  it('carries the Retry-After of a 5xx, in ms', async () => {
    const failure = await api(
      new Response('{}', {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '120' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect((failure as SendServerError).retryAfterMs).toBe(120_000);
  });

  it('reads Retry-After as seconds or an HTTP date against a given now, else null', () => {
    const now = Date.parse('Sun, 18 Oct 2026 12:00:00 GMT');
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs('Sun, 18 Oct 2026 12:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfterMs('Sun, 18 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('soon', now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });

  it('carries any other refusal status as a field, and it is not a SendServerError', async () => {
    const failure = await api(
      new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(refusalStatus(failure)).toBe(400);
    expect(failure).not.toBeInstanceOf(SendServerError);
  });
});

/**
 * THE EXCLUSIONS READ IS CLASSIFIED AT THE THROW TOO (third review of #1878). An untyped
 * `Error('getGroupExclusions failed: 403')` was a blip to every reader, so a roster-less device's
 * replies were held for good and the roster repair never ran.
 */
describe('getGroupExclusions on a refusal', () => {
  const api = (res: Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });
  const json = (status: number) =>
    new Response(JSON.stringify({ message: 'no' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('a gateway 403 is an answer about the ROSTER - typed, and never read as a send refusal', async () => {
    // The route refuses on the roster alone; a device `active` but roster-less sends freely. Read as
    // `sender-not-active`, it ran the roster repair - which forgets the tree - on a healthy device
    // (fourth review of #1878).
    const failure = await api(json(403))
      .getGroupExclusions('g1')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ExclusionsRefusedError);
    expect(failure).not.toBeInstanceOf(SenderNotActiveError);
    expect(classifyOutgoingSendError(failure)).toBe('unknown');
    expect(refusalStatus(failure)).toBe(403);
  });

  it('an edge 403 is the network path, never the roster', async () => {
    const failure = await api(
      new Response('<html>ban</html>', { status: 403, headers: { 'content-type': 'text/html' } })
    )
      .getGroupExclusions('g1')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SendEdgeRefusedError);
    expect(failure).not.toBeInstanceOf(SenderNotActiveError);
  });

  it('any other status carries it as a field', async () => {
    const failure = await api(json(503))
      .getGroupExclusions('g1')
      .catch((e: unknown) => e);

    expect(refusalStatus(failure)).toBe(503);
    expect(classifyOutgoingSendError(failure)).toBe('unknown');
  });
});

/**
 * A SEAT STILL AWAITING A MEMBER'S ADMISSION IS ANSWERED 409 `awaiting_admission` by every
 * membership-gated read (review of #2358): typed at the throw, never NotAGroupMemberError, on which a
 * caller retires the conversation.
 */
describe('the membership reads on a 409 awaiting_admission', () => {
  const api = (res: () => Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn(async () => res()) as unknown as typeof fetch,
    });
  const awaiting = () =>
    new Response(
      JSON.stringify({ error: 'awaiting_admission', message: 'a member has not admitted' }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    );
  const reads: [string, (a: MlsDeliveryApi) => Promise<unknown>][] = [
    ['getGroupUserMembers', (a) => a.getGroupUserMembers('g1')],
    ['getGroupMembers', (a) => a.getGroupMembers('g1')],
    ['getGroupExclusions', (a) => a.getGroupExclusions('g1')],
    ['fetchGroupInfo', (a) => a.fetchGroupInfo('g1')],
  ];

  it.each(reads)('%s raises AwaitingAdmissionError, still carrying its status', async (_, read) => {
    const failure = await read(api(awaiting)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AwaitingAdmissionError);
    expect(failure).not.toBeInstanceOf(NotAGroupMemberError);
    expect(failure).not.toBeInstanceOf(ExclusionsRefusedError);
    expect(refusalStatus(failure)).toBe(409);
    expect((failure as AwaitingAdmissionError).code).toBe('awaiting_admission');
  });

  it.each(reads)('%s leaves another 409 an ordinary refusal', async (_, read) => {
    const failure = await read(
      api(
        () =>
          new Response(JSON.stringify({ code: 'SEAT_CLAIM_OVERTAKEN' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
      )
    ).catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(AwaitingAdmissionError);
    expect(refusalStatus(failure)).toBe(409);
  });
});

/**
 * A SERVER THAT PREDATES `withheld` (2026-10-22) answers the route without it, for as long as a
 * store build runs ahead of production. That must fail the withheld read alone, typed - the union
 * every history answer and every received bundle depend on keeps working.
 */
describe('the windows read against a server that predates `withheld`', () => {
  const old = () =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ exclusions: { bob: [{ from: 1, until: 2 }] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      ) as unknown as typeof fetch,
    });

  it('still answers the exclusions', async () => {
    expect(await old().getGroupExclusions('g1')).toEqual(
      new Map([['bob', [{ from: 1, until: 2 }]]])
    );
  });

  it('refuses the withheld read with its own type, never as a malformed answer', async () => {
    const failure = await old()
      .getGroupWithheld('g1', 'carol')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(WithheldUnsupportedError);
  });

  it('asks `for` the one person, and shares the request with the exclusions asked for them', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ exclusions: {}, withheld: { me: [], carol: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([api.getGroupExclusions('g1', 'carol'), api.getGroupWithheld('g1', 'carol')]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('/exclusions?for=carol');
  });
});

describe('submitCommit declares whom the commit removes', () => {
  it('sends `removes` when there are any, and omits the field otherwise', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ accepted: true })));
    const delivery = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await delivery.submitCommit('g1', 5, 'AAAA', undefined, undefined, undefined, [
      { userId: 'user-b' },
    ]);
    await delivery.submitCommit('g1', 5, 'AAAA');

    const bodyOf = (i: number) => JSON.parse(String(fetchImpl.mock.calls[i][1].body));
    expect(bodyOf(0).removes).toEqual([{ userId: 'user-b' }]);
    expect(bodyOf(1)).not.toHaveProperty('removes');
  });
});
