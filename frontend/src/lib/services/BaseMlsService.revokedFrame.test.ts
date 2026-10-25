import { MlsDeliveryApi } from '$lib/mls-client/mlsDeliveryApi';
import { SessionEndedByDeviceRevocationError, SessionExpiredError } from '$lib/stores/auth';

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
    return a;
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('reports a revoked device', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ revoked: true }));

    await expect(api(fetchFn).isDeviceRevoked('u1', 'd1')).resolves.toBe(true);
    expect(String(fetchFn.mock.calls[0][0])).toContain('/api/mls/devices/u1/d1/revoked');
  });

  it('reports a device that is not revoked', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ revoked: false }));

    await expect(api(fetchFn).isDeviceRevoked('u1', 'd1')).resolves.toBe(false);
  });

  it('does not read an unreachable server as a revocation', async () => {
    // The whole point of the gate: erasing a device because the network was down would be the
    // worst possible reading of a transport failure.
    const fetchFn = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    await expect(api(fetchFn).isDeviceRevoked('u1', 'd1')).resolves.toBe(false);
  });

  it('does not read a server error as a revocation either', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({}, 500));

    await expect(api(fetchFn).isDeviceRevoked('u1', 'd1')).resolves.toBe(false);
  });

  it('asks about the device it was given, not about whatever init happened to leave behind', async () => {
    // THE IDS ARE ARGUMENTS BECAUSE THE ANSWER GATES A WIPE. A vault or biometric login asks this
    // BEFORE `init()`, when the ambient fields still hold their placeholders - and a question
    // about `unknown`/`pending` would come back "not revoked" for a reason that has nothing to do
    // with revocation. A wrong answer no caller could see was wrong is worse than no answer.
    const fetchFn = vi.fn().mockResolvedValue(json({ revoked: true }));
    const a = api(fetchFn);

    await expect(a.isDeviceRevoked('other-user', 'other-device')).resolves.toBe(true);
    expect(String(fetchFn.mock.calls[0][0])).toContain(
      '/api/mls/devices/other-user/other-device/revoked'
    );
    expect(a.userId).toBe('unknown');
    expect(a.deviceId).toBe('pending');
  });

  /**
   * THE REVOCATION ENDS THIS DEVICE'S SESSION, so the check usually meets a dead credential: a 401,
   * then a renewal the server refuses. When the refusal says the session died BY THIS REVOCATION, that
   * is the answer `true` - it used to be read as "unreachable, not revoked", and the device kept every
   * store (DEV-2, 2026-10-25). Any other dead session is no proof of a revocation.
   */
  describe('asked with the credential the revocation ended', () => {
    const deadSession = (renewal: () => Promise<string>) =>
      new MlsDeliveryApi({
        historyUrl: 'https://example.test',
        getToken: async () => 'token',
        refreshToken: renewal,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(
            json({ statusCode: 401, message: 'Unauthorized' }, 401)
          ) as unknown as typeof fetch,
      });

    it('reads a renewal refused BY THIS REVOCATION as revoked', async () => {
      const a = deadSession(async () => {
        throw new SessionEndedByDeviceRevocationError();
      });
      await expect(a.isDeviceRevoked('u1', 'd1')).resolves.toBe(true);
    });

    it('reads any other dead session as not revoked', async () => {
      const a = deadSession(async () => {
        throw new SessionExpiredError();
      });
      await expect(a.isDeviceRevoked('u1', 'd1')).resolves.toBe(false);
    });

    it('reads a token it cannot even obtain, latched as revoked, as revoked - without asking', async () => {
      const fetchFn = vi.fn();
      const a = new MlsDeliveryApi({
        historyUrl: 'https://example.test',
        getToken: async () => {
          throw new SessionEndedByDeviceRevocationError();
        },
        fetchImpl: fetchFn as unknown as typeof fetch,
      });
      await expect(a.isDeviceRevoked('u1', 'd1')).resolves.toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  it('treats a malformed answer as not revoked', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ revoked: 'yes' }));

    await expect(api(fetchFn).isDeviceRevoked('u1', 'd1')).resolves.toBe(false);
  });
});
