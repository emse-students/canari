import {
  DeliveryDeadlineError,
  KEY_PACKAGE_REQUEST_DEADLINE_MS,
  MlsDeliveryApi,
  PrekeyCountUnreadableError,
  raceDeadline,
} from './mlsDeliveryApi';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { keyPackagePublication } from './deviceKeyPackage';

/**
 * A REQUEST OF THE KEY PACKAGE ROUND THAT NEVER ANSWERS BECOMES A TYPED ERROR, NOT A STALLED GROUP.
 *
 * Before the deadline a hung `register-device` held the round - and every external join waiting
 * on it - for as long as the transport hung. The deadline reports, it never heals: each call below
 * ends in a failure (or the answer its method already gave for a failure), never in a retry.
 */
describe('the key package round has a per-request deadline', () => {
  /** A `fetch` that answers only by being aborted, like a socket that accepted and went silent. */
  const hangingFetch = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      })
  ) as unknown as typeof fetch;

  const makeApi = () => {
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: hangingFetch,
    });
    api.userId = 'u';
    api.deviceId = 'd';
    return api;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails registerDeviceKeyPackage with DeliveryDeadlineError', async () => {
    const failing = makeApi()
      .registerDeviceKeyPackage({ keyPackageBase64: 'AA==', notAfterSecs: 1, deviceOs: 'web' })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_REQUEST_DEADLINE_MS);
    const e = await failing;
    expect(e).toBeInstanceOf(DeliveryDeadlineError);
    expect((e as DeliveryDeadlineError).operation).toBe('register-device');
  });

  it('fails publishKeyPackages with DeliveryDeadlineError', async () => {
    const failing = makeApi()
      .publishKeyPackages([{ bytes: new Uint8Array([1]), notAfterSecs: 1 }])
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_REQUEST_DEADLINE_MS);
    expect(await failing).toBeInstanceOf(DeliveryDeadlineError);
  });

  it('FAILS the round on a prekey count that hangs - it is NOT read as 0', async () => {
    // Read as 0, both platforms mint and publish a full pool of fifty against a server that never
    // answered: the deadline would have become a heal.
    const counting = makeApi()
      .fetchPrekeyCount()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_REQUEST_DEADLINE_MS);
    const e = await counting;
    expect(e).toBeInstanceOf(DeliveryDeadlineError);
    expect((e as DeliveryDeadlineError).operation).toBe('prekey-count');
  });

  it('answers a hung purge with nothing to forget, ACCUSED at error level', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const purging = makeApi().deleteAllOneTimePrekeys();
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_REQUEST_DEADLINE_MS);
    expect(await purging).toEqual([]);
    expect(error.mock.calls.flat().join(' ')).toContain('prekey purge');
  });

  /** A count read through `fetchImpl`, and what it threw (or `null` when it answered). */
  const countThrough = async (fetchImpl: typeof fetch) => {
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl,
    });
    return api.fetchPrekeyCount().then(
      () => null,
      (e: unknown) => e
    );
  };

  // NOTHING A SERVER DID NOT SAY IS A ZERO (owner's Android log, 2026-11-25): a resolver failure was
  // read as an empty pool, and the phone minted fifty bundles it could not publish.
  it('throws on a count that got no answer, typed `transport` at the throw', async () => {
    const e = await countThrough(
      vi
        .fn()
        .mockRejectedValue(
          new TransportFailureError('error sending request')
        ) as unknown as typeof fetch
    );
    expect(e).toBeInstanceOf(PrekeyCountUnreadableError);
    expect((e as PrekeyCountUnreadableError).reason).toBe('transport');
  });

  it('types a body the link lost as `transport`, and a body that is not JSON as `malformed`', async () => {
    const lost = new Response('{"count":3}');
    vi.spyOn(lost, 'text').mockRejectedValue(new TypeError('body stream lost'));
    const e1 = await countThrough(vi.fn().mockResolvedValue(lost) as unknown as typeof fetch);
    expect((e1 as PrekeyCountUnreadableError).reason).toBe('transport');
    const e2 = await countThrough(
      vi.fn().mockResolvedValue(new Response('<html>portal</html>')) as unknown as typeof fetch
    );
    expect((e2 as PrekeyCountUnreadableError).reason).toBe('malformed');
  });

  it('types a 401 whose token renewal failed as `status` 401 - an answer, no count', async () => {
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      refreshToken: async () => {
        throw new TransportFailureError('refresh unreachable');
      },
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });
    const e = await api.fetchPrekeyCount().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PrekeyCountUnreadableError);
    expect((e as PrekeyCountUnreadableError).reason).toBe('status');
    expect((e as PrekeyCountUnreadableError).status).toBe(401);
  });

  it('throws on a refused count, typed `status` with the status it answered', async () => {
    const e = await countThrough(
      vi.fn().mockResolvedValue(new Response('{}', { status: 500 })) as unknown as typeof fetch
    );
    expect(e).toBeInstanceOf(PrekeyCountUnreadableError);
    expect((e as PrekeyCountUnreadableError).reason).toBe('status');
    expect((e as PrekeyCountUnreadableError).status).toBe(500);
  });

  it('throws on an answer without a count, typed `malformed`', async () => {
    const e = await countThrough(
      vi.fn().mockResolvedValue(new Response('{"pool":3}')) as unknown as typeof fetch
    );
    expect(e).toBeInstanceOf(PrekeyCountUnreadableError);
    expect((e as PrekeyCountUnreadableError).reason).toBe('malformed');
  });

  it('lets a defect of its own through as itself, never as a count', async () => {
    const bug = new RangeError('a bug of ours');
    const e = await countThrough(vi.fn().mockRejectedValue(bug) as unknown as typeof fetch);
    expect(e).toBe(bug);
  });

  it('reads an answered zero as zero - the one case a round mints a full pool', async () => {
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(new Response('{"count":0}')) as unknown as typeof fetch,
    });
    expect(await api.fetchPrekeyCount()).toBe(0);
  });

  it('answers `unanswered` for the fact read, which no join may act on', async () => {
    const reading = makeApi().fetchDeviceKeyPackage('u', 'd');
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_REQUEST_DEADLINE_MS);
    const answer = await reading;
    expect(answer.kind).toBe('unanswered');
    expect(keyPackagePublication(answer)).toBe('unknown');
  });

  it('does not fire for a request that answers in time', async () => {
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(new Response('{"count":7}')) as unknown as typeof fetch,
    });
    expect(await api.fetchPrekeyCount()).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('keyPackagePublication reads the fact the commit gate reads', () => {
  it.each([
    [{ kind: 'package', device: { keyPackage: new Uint8Array(), deviceId: 'd' } }, 'published'],
    [{ kind: 'none', reason: 'expired' }, 'published'],
    [{ kind: 'none', reason: 'unregistered' }, 'absent'],
    [{ kind: 'none', reason: 'unrecognized' }, 'absent'],
    [{ kind: 'none', reason: 'revoked' }, 'revoked'],
    [{ kind: 'unanswered', detail: 'x' }, 'unknown'],
  ] as const)('%j is %s', (answer, expected) => {
    expect(keyPackagePublication(answer as never)).toBe(expected);
  });
});

describe('raceDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves with the work when it finishes in time and arms nothing afterwards', async () => {
    const late = vi.fn();
    const raced = raceDeadline('op', Promise.resolve(7), 1000, late);
    expect(await raced).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(late).not.toHaveBeenCalled();
  });

  it('rejects the work failure in time as itself, not as a deadline', async () => {
    const boom = new Error('boom');
    await expect(raceDeadline('op', Promise.reject(boom), 1000, vi.fn())).rejects.toBe(boom);
  });

  it('rejects DeliveryDeadlineError at the deadline and reports a late SUCCESS to onLate', async () => {
    const late = vi.fn();
    let finish!: (v: number) => void;
    const raced = raceDeadline('op', new Promise<number>((r) => (finish = r)), 1000, late).catch(
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(1000);
    const e = await raced;
    expect(e).toBeInstanceOf(DeliveryDeadlineError);
    expect((e as DeliveryDeadlineError).deadlineMs).toBe(1000);
    expect(late).not.toHaveBeenCalled();

    finish(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });

  it('reports a late FAILURE to onLate with the error', async () => {
    const late = vi.fn();
    let fail!: (e: unknown) => void;
    const raced = raceDeadline('op', new Promise<number>((_r, rej) => (fail = rej)), 1000, late);
    raced.catch(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    const err = new Error('late');
    fail(err);
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledExactlyOnceWith({ ok: false, error: err });
  });
});
