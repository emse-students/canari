import {
  DeliveryDeadlineError,
  KEY_PACKAGE_REQUEST_DEADLINE_MS,
  MlsDeliveryApi,
} from './mlsDeliveryApi';
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

  it('keeps the failure answers of the count and the purge (0 and nothing)', async () => {
    const api = makeApi();
    const count = api.fetchPrekeyCount();
    const purge = api.deleteAllOneTimePrekeys();
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_REQUEST_DEADLINE_MS);
    expect(await count).toBe(0);
    expect(await purge).toEqual([]);
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
    [{ kind: 'none', reason: 'unspecified' }, 'absent'],
    [{ kind: 'none', reason: 'revoked' }, 'revoked'],
    [{ kind: 'unanswered', detail: 'x' }, 'unknown'],
  ] as const)('%j is %s', (answer, expected) => {
    expect(keyPackagePublication(answer as never)).toBe(expected);
  });
});
