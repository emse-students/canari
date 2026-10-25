/**
 * A 401 ON AN MLS DELIVERY REQUEST RENEWS THE TOKEN AND SENDS THE SAME BYTES ONCE MORE.
 *
 * Found by the dev campaign (TOK-1): a commit answered 401 - the auth guard's answer about the
 * bearer, given before the epoch gate - ended an Add with `ApiRefusalError (401)`, and the group
 * stayed at its old epoch. Every other first-party request renewed and resent (`apiFetch`, the media
 * upload); this class sent a plain `fetch` and nothing turned its 401 into a renewal. One rule now,
 * `renewOn401.ts`: renew, resend the SAME request once, `SessionExpiredError` only when the renewed
 * token is refused too, and a renewal that got no answer rethrown as the transport failure it is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MlsDeliveryApi } from './mlsDeliveryApi';
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

  it('throws SessionExpiredError when the renewed token is refused too, and sends no third', async () => {
    const f = vi.fn().mockResolvedValue(answer(401));
    const refresh = vi.fn().mockResolvedValue('fresh');
    await expect(submit(api(f, refresh))).rejects.toBeInstanceOf(SessionExpiredError);
    expect(f).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rethrows a renewal refused as dead AS ITSELF, with no resend', async () => {
    const f = vi.fn().mockResolvedValue(answer(401));
    const refresh = vi.fn().mockRejectedValue(new SessionExpiredError());
    await expect(submit(api(f, refresh))).rejects.toBeInstanceOf(SessionExpiredError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('rethrows a renewal that got NO ANSWER as a transport failure - never a session verdict', async () => {
    const f = vi.fn().mockResolvedValue(answer(401));
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

  it.each(siblings)('%s ends in SessionExpiredError on a second 401', async (_route, call) => {
    const f = vi.fn().mockResolvedValue(answer(401));
    const refresh = vi.fn().mockResolvedValue('fresh');
    await expect(call(api(f, refresh))).rejects.toBeInstanceOf(SessionExpiredError);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
