import { MlsDeliveryApi } from '$lib/mls-client/mlsDeliveryApi';

/**
 * A `device_revoked` frame asks a device to erase itself and sign out, which makes it a DESTRUCTIVE
 * CONTROL: it is confirmed against the server before anything is destroyed, and a question that
 * cannot be reached is never read as a yes. A transport failure is not an answer.
 */
describe('MlsDeliveryApi.isDeviceRevoked', () => {
  const api = (fetchFn: ReturnType<typeof vi.fn>) => {
    const a = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn as unknown as typeof fetch,
    });
    a.userId = 'u1';
    a.deviceId = 'd1';
    return a;
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('reports a revoked device', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ revoked: true }));

    await expect(api(fetchFn).isDeviceRevoked()).resolves.toBe(true);
    expect(String(fetchFn.mock.calls[0][0])).toContain('/api/mls/devices/u1/d1/revoked');
  });

  it('reports a device that is not revoked', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ revoked: false }));

    await expect(api(fetchFn).isDeviceRevoked()).resolves.toBe(false);
  });

  it('does not read an unreachable server as a revocation', async () => {
    // The whole point of the gate: erasing a device because the network was down would be the
    // worst possible reading of a transport failure.
    const fetchFn = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    await expect(api(fetchFn).isDeviceRevoked()).resolves.toBe(false);
  });

  it('does not read a server error as a revocation either', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({}, 500));

    await expect(api(fetchFn).isDeviceRevoked()).resolves.toBe(false);
  });

  it('treats a malformed answer as not revoked', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ revoked: 'yes' }));

    await expect(api(fetchFn).isDeviceRevoked()).resolves.toBe(false);
  });
});
