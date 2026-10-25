// @vitest-environment happy-dom
import { DeliveryUnreachableError, GroupExitRefusedError, MlsDeliveryApi } from './mlsDeliveryApi';
import {
  ackMessagesWithRetry,
  clearPersistedPendingAcks,
  readPersistedPendingAcks,
} from './ackRetry';
import { isDefinitiveCommitRefusal } from './commitSubmission';
import { NotFromApiError } from '$lib/utils/apiJson';
import { isTransportFailure } from '$lib/utils/transportFailure';

/**
 * A 2xx THAT IS NOT THE DELIVERY SERVICE'S JSON IS NO ANSWER. Under a captive portal every request is
 * answered `200 text/html` without reaching the server, and the send read that as "accepted, answer
 * unreadable": the outbox dropped a message nobody received (cross-client rig, `1.4.1-alpha.3`).
 * Each case is one response a member's device can meet on `/api/mls/*`.
 */
const portal = () =>
  new Response('<html><body>Sign in to use this network</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const makeApi = (...answers: Array<() => Response>) => {
  const fetchImpl = vi.fn(async () => answers.shift()!());
  const api = new MlsDeliveryApi({
    historyUrl: 'https://example.test',
    getToken: async () => 'token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  api.userId = 'u1';
  api.deviceId = 'd1';
  return { api, fetchImpl };
};

describe('postApplicationMessage reads WHO answered before it reads an acceptance', () => {
  it('a portal 200 (text/html) is a transport failure, never an accepted frame', async () => {
    const { api } = makeApi(portal);
    const failure = await api.postApplicationMessage('g1', 'AAAA').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DeliveryUnreachableError);
    expect(isTransportFailure(failure)).toBe(true);
    expect((failure as DeliveryUnreachableError).cause).toBeInstanceOf(NotFromApiError);
  });

  it('an empty 2xx is no answer either, whatever its content type says', async () => {
    const { api } = makeApi(
      () => new Response(null, { status: 200 }),
      () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    for (let i = 0; i < 2; i++) {
      const failure = await api.postApplicationMessage('g1', 'AAAA').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(DeliveryUnreachableError);
      expect((failure as DeliveryUnreachableError).cause).toBeInstanceOf(NotFromApiError);
    }
  });

  it("the service's JSON without `receivedAt` (a server predating it) is accepted and undated", async () => {
    const { api } = makeApi(() => Response.json({ status: 'sent', queued: 1, sent: 1 }));
    await expect(api.postApplicationMessage('g1', 'AAAA')).resolves.toBeNull();
  });

  it("the service's JSON of another shape is accepted and undated - the gateway answered", async () => {
    const { api } = makeApi(
      () => Response.json([1, 2]),
      () => Response.json({ receivedAt: 'yesterday' })
    );
    await expect(api.postApplicationMessage('g1', 'AAAA')).resolves.toBeNull();
    await expect(api.postApplicationMessage('g1', 'AAAA')).resolves.toBeNull();
  });

  it('the receive time the service answered is returned', async () => {
    const { api } = makeApi(() => Response.json({ receivedAt: 1_700_000_000_123 }));
    await expect(api.postApplicationMessage('g1', 'AAAA')).resolves.toBe(1_700_000_000_123);
  });
});

describe('the commit gate, the published base and the pull read a portal the same way', () => {
  it('a portal 200 on POST /commit is no verdict: a transport failure, never a refusal', async () => {
    const { api } = makeApi(portal);
    const failure = await api.submitCommit('g1', 3, 'AAAA').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect(isTransportFailure(failure)).toBe(true);
    // The caller keeps the stage and resubmits on exactly this reading.
    expect(isDefinitiveCommitRefusal(failure)).toBe(false);
  });

  it("the gate's own JSON is still its verdict", async () => {
    const { api } = makeApi(() => Response.json({ accepted: true, newEpoch: 4 }));
    await expect(api.submitCommit('g1', 3, 'AAAA')).resolves.toEqual({
      accepted: true,
      newEpoch: 4,
    });
  });

  it('a portal 200 on POST /group-info is no answer, never `stored: false`', async () => {
    const { api } = makeApi(portal);
    const failure = await api.storeGroupInfo('g1', 'AAAA', 3).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
  });

  it('a portal 200 on GET /group-info is no answer, never "no base"', async () => {
    const { api } = makeApi(portal, () => Response.json({ groupInfo: null }));
    const failure = await api.fetchGroupInfo('g1').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    // The server's own "nothing stored" is still read as no base.
    await expect(api.fetchGroupInfo('g1')).resolves.toBeNull();
  });

  it('a JSON-typed pull page that does not parse fails at once too, as the same type', async () => {
    const { api, fetchImpl } = makeApi(
      () => new Response('{"half', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const failure = await api.pullPendingMessagesJson().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect((failure as NotFromApiError).cause).toBeInstanceOf(SyntaxError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a portal 200 on the pending pull fails at once - one request, no halving against it', async () => {
    const { api, fetchImpl } = makeApi(portal);
    const failure = await api.pullPendingMessagesJson().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("a delete for everyone is done only on the delivery service's answer", () => {
  it('a 404 is refused, never "already gone" - the route never sends one', async () => {
    const { api } = makeApi(() => new Response('Not Found', { status: 404 }));
    await expect(api.deleteGroupOnServer('g1')).rejects.toBeInstanceOf(GroupExitRefusedError);
  });

  it('a portal 200 is no answer', async () => {
    const { api } = makeApi(portal);
    await expect(api.deleteGroupOnServer('g1')).rejects.toBeInstanceOf(NotFromApiError);
  });

  it("the service's JSON 200 is done", async () => {
    const { api } = makeApi(() => Response.json({ status: 'deleted' }));
    await expect(api.deleteGroupOnServer('g1')).resolves.toBeUndefined();
  });
});

describe('an ACK a portal answered acknowledged nothing', () => {
  const body = { userId: 'user-a', deviceId: 'device-a', messageIds: ['row-1'] };

  beforeEach(() => {
    clearPersistedPendingAcks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearPersistedPendingAcks();
  });

  it('keeps the ids, and the attempt after the portal acknowledges them', async () => {
    const answers: Array<() => Response> = [
      portal,
      portal,
      portal,
      portal,
      () => Response.json({ status: 'deleted', count: 1 }),
    ];
    const fetchFn = vi.fn(async () => answers.shift()!());
    vi.stubGlobal('fetch', fetchFn);
    const logs: string[] = [];

    const first = ackMessagesWithRetry('https://example.test', {}, body, (l) => logs.push(l));
    await vi.advanceTimersByTimeAsync(10_000);
    await first;

    // Four attempts, each read as a failure, then the ids are kept for the next connect.
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(logs.some((l) => l.includes('NotFromApiError'))).toBe(true);
    expect(readPersistedPendingAcks()?.messageIds).toEqual(['row-1']);

    // The portal ends: the next ack carries the kept ids and clears them only on the API's answer.
    await ackMessagesWithRetry('https://example.test', {}, { ...body, messageIds: [] });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(
      JSON.parse((fetchFn.mock.calls[4] as unknown as [string, RequestInit])[1].body as string)
    ).toEqual({
      ...body,
      messageIds: ['row-1'],
    });
    expect(readPersistedPendingAcks()).toBeNull();
  });
});
