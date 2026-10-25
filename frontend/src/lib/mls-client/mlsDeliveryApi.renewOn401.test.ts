/**
 * A 401 ON AN MLS DELIVERY REQUEST RENEWS THE TOKEN AND SENDS THE SAME BYTES ONCE MORE.
 *
 * Found by the dev campaign (TOK-1): a commit answered 401 - the auth guard's answer about the
 * bearer, given before the epoch gate - ended an Add with `ApiRefusalError (401)`, and the group
 * stayed at its old epoch. Every other first-party request renewed and resent (`apiFetch`, the media
 * upload); this class sent a plain `fetch` and nothing turned its 401 into a renewal. One rule now,
 * `renewOn401.ts`: renew, resend the SAME request once, and a renewal that got no answer rethrown as
 * the transport failure it is. A renewed token refused too is `DeliveryRefusedRenewedTokenError`, a
 * failed request and NEVER a logout: the delivery guard also answers 401 for its own faults.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryRefusedRenewedTokenError, MlsDeliveryApi } from './mlsDeliveryApi';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { SessionExpiredError } from '$lib/stores/auth';
import { isTransportFailure, TransportFailureError } from '$lib/utils/transportFailure';

const ACCEPTED = { accepted: true, newEpoch: 2 };

function answer(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The bearer each call carried, read the way a server reads it. */
const bearers = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => new Headers((c[1] as RequestInit).headers).get('Authorization'));
const bodies = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => String((c[1] as RequestInit).body));

function api(fetchImpl: ReturnType<typeof vi.fn>, refreshToken: ReturnType<typeof vi.fn>) {
  const a = new MlsDeliveryApi({
    historyUrl: 'https://delivery.test',
    getToken: async () => 'stale',
    refreshToken: refreshToken as () => Promise<string>,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  a.userId = 'user-a';
  a.deviceId = 'web-a';
  return a;
}

const submit = (a: MlsDeliveryApi) =>
  a.submitCommit('g-1', 1, 'AQ==', undefined, 'Ag==', [{ userId: 'user-b', deviceId: 'web-b' }]);

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('submitCommit answered 401', () => {
  it('renews the token and sends the SAME bytes once more, answered once', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(answer(401))
      .mockResolvedValueOnce(answer(200, ACCEPTED));
    const refresh = vi.fn().mockResolvedValue('fresh');
    await expect(submit(api(f, refresh))).resolves.toEqual(ACCEPTED);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(bearers(f)).toEqual(['Bearer stale', 'Bearer fresh']);
    const [first, second] = bodies(f);
    expect(second).toBe(first);
    // The device header travels on the resend too: only the bearer changed.
    expect(new Headers((f.mock.calls[1][1] as RequestInit).headers).get('X-Canari-Device')).toBe(
      'web-a'
    );
  });

  it('a renewed token refused too is a typed failed request - never a session verdict - and no third', async () => {
    const f = vi
      .fn()
      .mockImplementation(async () => answer(401, { code: 'INTERNAL_AUTH_UNCONFIGURED' }));
    const refresh = vi.fn().mockResolvedValue('fresh');
    const err = await submit(api(f, refresh)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryRefusedRenewedTokenError);
    expect(err).toBeInstanceOf(ApiRefusalError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect((err as ApiRefusalError).status).toBe(401);
    expect((err as ApiRefusalError).code).toBe('INTERNAL_AUTH_UNCONFIGURED');
    expect(f).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rethrows a renewal refused as dead AS ITSELF, with no resend', async () => {
    const f = vi.fn().mockImplementation(async () => answer(401));
    const refresh = vi.fn().mockRejectedValue(new SessionExpiredError());
    await expect(submit(api(f, refresh))).rejects.toBeInstanceOf(SessionExpiredError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('rethrows a renewal that got NO ANSWER as a transport failure - never a session verdict', async () => {
    const f = vi.fn().mockImplementation(async () => answer(401));
    const refresh = vi
      .fn()
      .mockRejectedValue(new TransportFailureError(new TypeError('Failed to fetch')));
    const err = await submit(api(f, refresh)).catch((e: unknown) => e);
    expect(isTransportFailure(err)).toBe(true);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('leaves every other status to the caller, with no renewal', async () => {
    const f = vi.fn().mockResolvedValue(answer(403, { message: 'no' }));
    const refresh = vi.fn();
    await expect(submit(api(f, refresh))).rejects.toMatchObject({ status: 403 });
    expect(refresh).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

/** The sibling writes of the same shape: each one obeys the same rule, by the same seam. */
describe('the other MLS delivery writes answered 401', () => {
  const siblings: Array<[string, (a: MlsDeliveryApi) => Promise<unknown>, Response]> = [
    [
      'POST /api/mls/welcome',
      (a) => a.sendWelcome(new Uint8Array([1]), 'user-b', 'g-1', 'web-b'),
      answer(201),
    ],
    [
      'POST /api/mls/register-device',
      (a) =>
        a.registerDeviceKeyPackage({
          keyPackageBase64: 'AQ==',
          notAfterSecs: 2_000_000_000,
          deviceOs: 'web',
        }),
      answer(201),
    ],
    [
      'POST /api/mls/register-device/prekeys',
      (a) => a.publishKeyPackages([{ bytes: new Uint8Array([1]), notAfterSecs: 2_000_000_000 }]),
      answer(201),
    ],
    [
      'POST /api/mls/groups',
      (a) => a.createRemoteGroup('name', true),
      answer(201, { groupId: 'g-new' }),
    ],
  ];

  it.each(siblings)('%s renews and resends the same body once', async (_route, call, ok) => {
    const f = vi.fn().mockResolvedValueOnce(answer(401)).mockResolvedValueOnce(ok);
    const refresh = vi.fn().mockResolvedValue('fresh');
    await call(api(f, refresh));
    expect(f).toHaveBeenCalledTimes(2);
    expect(bearers(f)).toEqual(['Bearer stale', 'Bearer fresh']);
    const [first, second] = bodies(f);
    expect(second).toBe(first);
  });

  it.each(siblings)('%s fails, never a logout, on a second 401', async (_route, call) => {
    const f = vi.fn().mockImplementation(async () => answer(401));
    const refresh = vi.fn().mockResolvedValue('fresh');
    const err = await call(api(f, refresh)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryRefusedRenewedTokenError);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

/**
 * THE PENDING PULL APPLIES THE RULE OUTSIDE ITS PAGE-HALVING LADDER: a page that goes silent is asked
 * smaller, but a renewal is not a page - a slow one must not halve, a failed one is thrown as itself.
 */
describe('the pending pull answered 401', () => {
  const page = (rows: unknown[]) => answer(200, rows);
  const limits = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('limit'));

  it('renews and asks the SAME page again, under its own stall timer', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(answer(401))
      .mockResolvedValueOnce(page([{ createdAt: 'a' }]))
      .mockResolvedValueOnce(page([]));
    const refresh = vi.fn().mockResolvedValue('fresh');
    const rows = await api(f, refresh).pullPendingMessagesJson();
    expect(rows).toHaveLength(1);
    expect(bearers(f).slice(0, 2)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(limits(f).slice(0, 2)).toEqual(['500', '500']);
  });

  it('a renewal slower than the stall timer does not halve the page', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn().mockResolvedValueOnce(answer(401)).mockResolvedValueOnce(page([]));
      const refresh = vi.fn(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('fresh'), 60))
      );
      const pull = api(f, refresh).pullPendingMessagesJson({ stallTimeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(60);
      await pull;
      expect(limits(f)).toEqual(['500', '500']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a renewal nobody answered is thrown as a transport failure, never halved', async () => {
    const f = vi.fn().mockImplementation(async () => answer(401));
    const refresh = vi
      .fn()
      .mockRejectedValue(new TransportFailureError(new TypeError('Failed to fetch')));
    const err = await api(f, refresh)
      .pullPendingMessagesJson()
      .catch((e: unknown) => e);
    expect(isTransportFailure(err)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
