import { describe, expect, it, vi } from 'vitest';
import { DeviceRevokedByOwnerError, DeviceRevokedError, MlsDeliveryApi } from './mlsDeliveryApi';

/**
 * A BANNED DEVICE ID IS TYPED BY WHO BANNED IT, AT THE THROW. Only an explicit `reason: 'retired'`
 * licenses a re-enrolment under a fresh id; an owner's revocation - and a refusal that does not say
 * who, from a server older than the reason - is `DeviceRevokedByOwnerError`, which the key-package
 * round answers with a wipe and never a rotation.
 */
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function api(res: Response): { client: MlsDeliveryApi; fetchFn: ReturnType<typeof vi.fn> } {
  const fetchFn = vi.fn().mockResolvedValue(res);
  const client = new MlsDeliveryApi({
    historyUrl: 'https://example.test',
    getToken: async () => 'token',
    fetchImpl: fetchFn as unknown as typeof fetch,
  });
  client.userId = 'u1';
  client.deviceId = 'd1';
  return { client, fetchFn };
}

const register = (client: MlsDeliveryApi) =>
  client
    .registerDeviceKeyPackage({
      keyPackageBase64: 'AAAA',
      notAfterSecs: 2_000_000_000,
      deviceOs: 'web',
    })
    .catch((e: unknown) => e);

const publish = (client: MlsDeliveryApi) =>
  client
    .publishKeyPackages([{ bytes: new Uint8Array([1]), notAfterSecs: 2_000_000_000 }])
    .catch((e: unknown) => e);

describe('a device-creating call refused for a banned id', () => {
  it.each([
    ['register-device', register],
    ['the prekey upload', publish],
  ])('%s: DEVICE_REVOKED_BY_OWNER is an owner revocation', async (_route, call) => {
    const failure = await call(
      api(json(403, { code: 'DEVICE_REVOKED_BY_OWNER', reason: 'owner' })).client
    );
    expect(failure).toBeInstanceOf(DeviceRevokedByOwnerError);
    expect((failure as DeviceRevokedByOwnerError).reasonStated).toBe(true);
  });

  it.each([
    ['register-device', register],
    ['the prekey upload', publish],
  ])(
    "%s: DEVICE_REVOKED with reason 'retired' is the one licence to re-enrol",
    async (_r, call) => {
      const failure = await call(
        api(json(403, { code: 'DEVICE_REVOKED', reason: 'retired' })).client
      );
      expect(failure).toBeInstanceOf(DeviceRevokedError);
      expect(failure).not.toBeInstanceOf(DeviceRevokedByOwnerError);
    }
  );

  it.each([
    ['no reason (a server older than it)', { code: 'DEVICE_REVOKED' }],
    ['a reason this client does not know', { code: 'DEVICE_REVOKED', reason: 'stolen' }],
  ])('fails SAFE on %s: read as the owner, said at error', async (_label, body) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = await register(api(json(403, body)).client);
    expect(failure).toBeInstanceOf(DeviceRevokedByOwnerError);
    expect((failure as DeviceRevokedByOwnerError).reasonStated).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('WITHOUT saying who revoked it'));
    error.mockRestore();
  });

  it('leaves any other 403 to the ordinary refusal', async () => {
    const failure = await register(api(json(403, { message: 'nope' })).client);
    expect(failure).not.toBeInstanceOf(DeviceRevokedError);
    expect(failure).not.toBeInstanceOf(DeviceRevokedByOwnerError);
  });
});

describe('deleteDevice', () => {
  it("names 'retired' only when asked, so a plain delete is the owner's revocation", async () => {
    const ok = () => json(200, { status: 'device_deleted' });
    const owner = api(ok());
    await owner.client.deleteDevice('u1', 'd2');
    expect(String(owner.fetchFn.mock.calls[0][0])).toBe(
      'https://example.test/api/mls/devices/u1/d2'
    );

    const retired = api(ok());
    await retired.client.deleteDevice('u1', 'd2', 'retired');
    expect(String(retired.fetchFn.mock.calls[0][0])).toBe(
      'https://example.test/api/mls/devices/u1/d2?reason=retired'
    );
  });
});
