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
