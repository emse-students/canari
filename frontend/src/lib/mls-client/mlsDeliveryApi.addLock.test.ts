import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { isTransportFailure, TransportFailureError } from '$lib/utils/transportFailure';
import {
  ADD_LOCK_WAIT_BOUND_MS,
  boundAddLockWait,
  MlsDeliveryApi,
  type MlsDeliveryFetch,
} from './mlsDeliveryApi';

/**
 * The add-lock release on the wire. `owed: true` is the client's statement that a release is the
 * one a page owed for an acquisition it never saw released - the only thing that tells that
 * `[RELEASE_LOCK] released=false` from a slow Add whose TTL ran out under it. It is sent on that
 * release alone.
 */
function makeApi(bodies: unknown[]): MlsDeliveryApi {
  const fetchImpl: MlsDeliveryFetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{"released":false}', { status: 200 });
  };
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

describe('releaseAddLock', () => {
  it('an OWED release carries owed: true, and an ordinary release does not', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const api = makeApi(bodies);
    await api.releaseAddLock('g1', 't1', { owed: true });
    await api.releaseAddLock('g1', 't2');
    await api.releaseAddLock('g1', undefined);
    expect(bodies[0]).toMatchObject({ groupId: 'g1', token: 't1', owed: true });
    expect(bodies[1]).toMatchObject({ groupId: 'g1', token: 't2' });
    expect(bodies[1]).not.toHaveProperty('owed');
    expect(bodies[2]).not.toHaveProperty('owed');
    expect(bodies[2]).not.toHaveProperty('token');
  });
});

describe('boundAddLockWait', () => {
  it('keeps a wait inside 0..TTL+1 s as stated', () => {
    expect(boundAddLockWait(7_000)).toBe(7_000);
    expect(boundAddLockWait(0)).toBe(0);
  });

  it('bounds a negative wait to 0, and a huge one (setTimeout fires above 2^31-1 at once) to TTL+1 s', () => {
    expect(boundAddLockWait(-5)).toBe(0);
    expect(boundAddLockWait(2 ** 40)).toBe(ADD_LOCK_WAIT_BOUND_MS);
    expect(ADD_LOCK_WAIT_BOUND_MS).toBe(31_000);
  });

  it('reads NaN, an infinity and an absent value as NO stated end', () => {
    expect(boundAddLockWait(Number.NaN)).toBeUndefined();
    expect(boundAddLockWait(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(boundAddLockWait(undefined)).toBeUndefined();
  });
});

/** An API whose every request is answered by `answer` (or rejected by it), recording the bodies. */
function answeringApi(
  answer: () => Promise<Response>,
  calls: Array<{ url: string; body: Record<string, unknown> }> = []
): MlsDeliveryApi {
  const fetchImpl: MlsDeliveryFetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return answer();
  };
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('acquireAddLock', () => {
  it('asks to be told of the release only when the caller says so', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const api = answeringApi(async () => json({ acquired: false, retryAfterMs: 5_000 }), calls);
    await expect(api.acquireAddLock('g1', { notifyRelease: true })).resolves.toEqual({
      acquired: false,
      retryAfterMs: 5_000,
    });
    await api.acquireAddLock('g1');
    expect(calls[0].body).toMatchObject({ groupId: 'g1', notifyRelease: true });
    expect(calls[1].body).not.toHaveProperty('notifyRelease');
  });

  it('a request NOTHING answered THROWS, typed - it is never read as held by someone else (NET-3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = answeringApi(async () => {
        throw new TransportFailureError(new TypeError('Failed to fetch'));
      });
      const thrown = await api.acquireAddLock('g1').catch((e: unknown) => e);
      expect(isTransportFailure(thrown)).toBe(true);
      // Said once, by whoever reads the outcome - not here as well.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('renewAddLock', () => {
  it('names the acquisition by its token, and reads the answer', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const api = answeringApi(async () => json({ renewed: true }), calls);
    await expect(api.renewAddLock('g1', 't1')).resolves.toBe('renewed');
    expect(calls[0].url).toBe('https://test.local/api/mls/add-lock/renew');
    expect(calls[0].body).toMatchObject({ groupId: 'g1', token: 't1' });
  });

  it('a lock that is no longer this acquisition is LOST', async () => {
    const api = answeringApi(async () => json({ renewed: false }));
    await expect(api.renewAddLock('g1', 't1')).resolves.toBe('lost');
  });

  it('a server with no such route (404) is UNSUPPORTED, never lost', async () => {
    const api = answeringApi(async () => json({ message: 'Cannot POST' }, 404));
    await expect(api.renewAddLock('g1', 't1')).resolves.toBe('unsupported');
  });

  it('any other refusal THROWS, typed - it is not a renewal', async () => {
    const api = answeringApi(async () => json({ code: 'INTERNAL' }, 500));
    await expect(api.renewAddLock('g1', 't1')).rejects.toBeInstanceOf(ApiRefusalError);
  });

  it('a request nothing answered THROWS, typed', async () => {
    const api = answeringApi(async () => {
      throw new TransportFailureError(new TypeError('Failed to fetch'));
    });
    const thrown = await api.renewAddLock('g1', 't1').catch((e: unknown) => e);
    expect(isTransportFailure(thrown)).toBe(true);
  });
});
