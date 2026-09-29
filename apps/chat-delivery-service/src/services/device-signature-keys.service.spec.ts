import { BadRequestException } from '@nestjs/common';
import { DeviceSignatureKeysService } from './device-signature-keys.service';
import { readKeyPackageLeaf } from '../utils/key-package-leaf';
import { stubQueryBuilder } from '../testing/queryBuilder';
import { ALICE_KEY_PACKAGE } from '../testing/keyPackageFixture';

const ALICE_KEY = readKeyPackageLeaf(ALICE_KEY_PACKAGE)!.signatureKey;

function build(opts: { history?: string[]; current?: string | null; inserted?: number } = {}) {
  const builder = stubQueryBuilder({
    execute: { raw: Array.from({ length: opts.inserted ?? 1 }, (_, i) => ({ id: `r${i}` })) },
  });
  const keyRepo = {
    createQueryBuilder: jest.fn(() => builder),
    find: jest
      .fn()
      .mockResolvedValue((opts.history ?? []).map((signatureKey) => ({ signatureKey }))),
  };
  const keyPackageRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        opts.current === null ? null : { keyPackage: opts.current ?? ALICE_KEY_PACKAGE }
      ),
  };
  const service = new DeviceSignatureKeysService(keyRepo as never, keyPackageRepo as never);
  const logger = (service as unknown as { logger: Record<string, (m: string) => void> }).logger;
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  return { service, builder, keyRepo, error, log };
}

/** The `values(...)` a recording inserted, or undefined when it inserted nothing. */
function insertedValues(builder: ReturnType<typeof stubQueryBuilder>) {
  return builder.calls.find((c) => c.method === 'values')?.args[0];
}

describe('DeviceSignatureKeysService.record', () => {
  it('records the key ONCE for a batch whose packages all carry it, idempotently', async () => {
    const { service, builder, log } = build();
    await service.record('alice-user', 'dev-a1', [ALICE_KEY_PACKAGE, ALICE_KEY_PACKAGE], 'prekeys');

    expect(insertedValues(builder)).toEqual([
      { userId: 'alice-user', deviceId: 'dev-a1', signatureKey: ALICE_KEY },
    ]);
    expect(builder.calls.map((c) => c.method)).toContain('orIgnore');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[DEVICE_KEY] RECORDED'));
  });

  it('says nothing when the key was already known - a refill is not news', async () => {
    const { service, log } = build({ inserted: 0 });
    await service.record('alice-user', 'dev-a1', [ALICE_KEY_PACKAGE], 'prekeys');
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a package whose credential names another device - the upload stores nothing', async () => {
    const { service, builder, error } = build();
    await expect(
      service.record('mallory', 'dev-m', [ALICE_KEY_PACKAGE], 'register-device')
    ).rejects.toMatchObject({
      response: { code: 'KEY_PACKAGE_IDENTITY_INVALID', foreignIdentity: 1, unreadable: 0 },
    });

    expect(insertedValues(builder)).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('foreignIdentity=1'));
  });

  it('refuses a WHOLE batch when one package in it cannot be read', async () => {
    const { service, builder, error } = build();
    await expect(
      service.record('alice-user', 'dev-a1', [ALICE_KEY_PACKAGE, 'AAAA'], 'prekeys')
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(insertedValues(builder)).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable=1'));
  });
});

describe('DeviceSignatureKeysService.keysFor', () => {
  it('answers the history, oldest first, plus the current package key when it is new', async () => {
    const { service } = build({ history: ['old-key'] });
    await expect(service.keysFor('alice-user', 'dev-a1')).resolves.toEqual(['old-key', ALICE_KEY]);
  });

  it('does not repeat a current key the history already holds', async () => {
    const { service } = build({ history: [ALICE_KEY] });
    await expect(service.keysFor('alice-user', 'dev-a1')).resolves.toEqual([ALICE_KEY]);
  });

  it('answers an empty list for a device that published nothing', async () => {
    const { service, error } = build({ current: null });
    await expect(service.keysFor('ghost', 'dev-g')).resolves.toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('refuses to serve a current package that names another device', async () => {
    const { service, error } = build();
    await expect(service.keysFor('mallory', 'dev-m')).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable or foreign'));
  });
});
