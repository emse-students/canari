import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';
import { refusalIsTemporary, refusalRetiresInvitation } from './deviceKeyPackage';

/**
 * WHAT THE `null` HID.
 *
 * `fetchDeviceKeyPackage` returned `null` for a 404, a 500, a gateway error, a body that did not
 * parse and an unreachable network alike. Its caller retired a pending invitation on it, so a bad
 * minute on one endpoint could abandon an invitation that was perfectly valid - the exact shape the
 * rule "a status code is an ANSWER, a transport failure is not" exists to prevent.
 *
 * These cases pin the three shapes, and in particular the line between them: only a 404 says
 * anything at all about the device.
 */
describe('asking for one device KeyPackage', () => {
  const api = (fetchFn: ReturnType<typeof vi.fn>) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn as unknown as MlsDeliveryFetch,
    });

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('returns the package, decoded, on a 200', async () => {
    // Base64 of the three bytes 1,2,3 - the wire shape a KeyPackage travels in.
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ deviceId: 'd1', keyPackage: 'AQID', deviceName: 'Pixel' }, 200));

    const answer = await api(fetchFn).fetchDeviceKeyPackage('u1', 'd1');

    expect(answer.kind).toBe('package');
    if (answer.kind !== 'package') throw new Error('unreachable');
    expect(answer.device.deviceId).toBe('d1');
    expect(Array.from(answer.device.keyPackage)).toEqual([1, 2, 3]);
    expect(answer.device.deviceName).toBe('Pixel');
  });

  it.each(['revoked', 'unregistered', 'expired'] as const)(
    'carries the server’s `%s` out of the 404 body',
    async (reason) => {
      const fetchFn = vi.fn().mockResolvedValue(json({ statusCode: 404, reason }, 404));

      const answer = await api(fetchFn).fetchDeviceKeyPackage('u1', 'd1');

      expect(answer).toEqual({ kind: 'none', reason });
    }
  );

  /**
   * Every delivery service since 2026-09-16 names its reason, so a 404 with none is not that
   * service answering - it establishes nothing, and nothing is retired. The caller logs it, once per sweep.
   */
  it('says a 404 naming no reason established nothing, without logging it itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchFn = vi.fn().mockResolvedValue(json({ statusCode: 404, message: 'nope' }, 404));

    expect(await api(fetchFn).fetchDeviceKeyPackage('u1', 'd1')).toEqual({
      kind: 'unanswered',
      detail: 'a 404 with no reason in it',
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * A reason this build does not know is still the server ANSWERING (one added after this build
   * shipped): it is typed `unrecognized`, which retires nothing, and it is warned about ONCE - every
   * sweep meets it again, and a repeated line is noise.
   */
  it('reads a 404 with an UNKNOWN reason as an unrecognized refusal, warned once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A fresh Response per call: a body is read once.
    const fetchFn = vi
      .fn()
      .mockImplementation(async () => json({ reason: 'something-newer' }, 404));
    const client = api(fetchFn);

    for (let sweep = 0; sweep < 3; sweep++) {
      expect(await client.fetchDeviceKeyPackage('u1', 'd1')).toEqual({
        kind: 'none',
        reason: 'unrecognized',
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it.each([500, 502, 503, 401])('says %d established NOTHING about the device', async (status) => {
    const fetchFn = vi.fn().mockResolvedValue(json({}, status));

    const answer = await api(fetchFn).fetchDeviceKeyPackage('u1', 'd1');

    expect(answer.kind).toBe('unanswered');
    if (answer.kind !== 'unanswered') throw new Error('unreachable');
    expect(answer.detail).toContain(String(status));
  });

  it('says an unreachable network established nothing either', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const answer = await api(fetchFn).fetchDeviceKeyPackage('u1', 'd1');

    expect(answer.kind).toBe('unanswered');
    if (answer.kind !== 'unanswered') throw new Error('unreachable');
    expect(answer.detail).toContain('unreachable');
  });

  /** A 200 that is not a key package is the server failing to answer, not the device being absent. */
  it('says a 200 with no key package in it established nothing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ deviceId: 'd1' }, 200));

    expect(await api(fetchFn).fetchDeviceKeyPackage('u1', 'd1')).toEqual({
      kind: 'unanswered',
      detail: 'a 200 with no key package in it',
    });
  });
});

describe('refusalIsTemporary', () => {
  /**
   * The one behavioural difference between the refusals: an elapsed package is replaced by the
   * device itself on its next connection, and `registerDevice` re-creates the pending membership.
   */
  it('is true for the elapsed package and false for the other three', () => {
    expect(refusalIsTemporary('expired')).toBe(true);
    expect(refusalIsTemporary('revoked')).toBe(false);
    expect(refusalIsTemporary('unregistered')).toBe(false);
    expect(refusalIsTemporary('unrecognized')).toBe(false);
  });
});

describe('refusalRetiresInvitation', () => {
  /** An allowlist, because retiring is destructive: only the reasons this build can judge retire. */
  it('retires on the three known reasons and keeps the invitation on an unrecognized one', () => {
    expect(refusalRetiresInvitation('revoked')).toBe(true);
    expect(refusalRetiresInvitation('unregistered')).toBe(true);
    expect(refusalRetiresInvitation('expired')).toBe(true);
    expect(refusalRetiresInvitation('unrecognized')).toBe(false);
  });
});
