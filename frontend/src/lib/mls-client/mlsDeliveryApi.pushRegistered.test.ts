import { describe, expect, it, vi } from 'vitest';
import { MlsDeliveryApi } from './mlsDeliveryApi';

/**
 * `register-device` CARRIES THE PUSH FACT BOTH WAYS: the device states what its last push
 * registration came to, and the delivery service answers whether it holds one for the device - the
 * answer `reconcilePushRegistration` re-registers on. A service that does not say answers `null`,
 * never a guess in either direction.
 */
function api(body: unknown): { client: MlsDeliveryApi; fetchFn: ReturnType<typeof vi.fn> } {
  const fetchFn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  );
  const client = new MlsDeliveryApi({
    historyUrl: 'https://example.test',
    getToken: async () => 'token',
    fetchImpl: fetchFn as unknown as typeof fetch,
  });
  client.userId = 'u1';
  client.deviceId = 'd1';
  return { client, fetchFn };
}

const PARAMS = { keyPackageBase64: 'AAAA', notAfterSecs: 2_000_000_000, deviceOs: 'android' };

describe('registerDeviceKeyPackage and the push registration', () => {
  it.each([
    [{ status: 'registered', push: { registered: true } }, true],
    [{ status: 'registered', push: { registered: false } }, false],
    [{ status: 'registered' }, null],
    [{ status: 'registered', push: { registered: 'yes' } }, null],
  ])('answers %j as pushRegistered=%s', async (body, expected) => {
    const answer = await api(body).client.registerDeviceKeyPackage(PARAMS);
    expect(answer).toEqual({ pushRegistered: expected });
  });

  it('states the last outcome when given one, and only then', async () => {
    const stated = api({ status: 'registered' });
    await stated.client.registerDeviceKeyPackage({ ...PARAMS, pushOutcome: 'unauthorized' });
    const silent = api({ status: 'registered' });
    await silent.client.registerDeviceKeyPackage(PARAMS);

    const bodyOf = (f: ReturnType<typeof vi.fn>) =>
      JSON.parse((f.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(bodyOf(stated.fetchFn).pushOutcome).toBe('unauthorized');
    expect(bodyOf(silent.fetchFn)).not.toHaveProperty('pushOutcome');
  });
});
