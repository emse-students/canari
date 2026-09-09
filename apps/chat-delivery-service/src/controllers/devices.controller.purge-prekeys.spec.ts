/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DevicesController } from './devices.controller';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * THE PURGE MUST SAY WHAT IT DELETED, BECAUSE THE CLIENT CANNOT WORK IT OUT.
 *
 * Publishing a one-time prekey writes a private bundle on the device, and until 2026-09-09 nothing
 * ever deleted one: this endpoint emptied the server and the device kept the whole abandoned pool
 * for the 84 days until the lifetimes elapsed. `republishKeyMaterial` calls it once per 30 s during
 * a `NoMatchingKeyPackage` storm, so each round orphaned fifty. Measured on a Mi 9T on 2026-09-09:
 * 2782 one-time bundles against a pool of FIFTY, two thirds of a 10.7 MB state, none yet expired.
 *
 * The device may not derive the set itself. `resolveKeyPackagePayloadForDevice` DELETES a row as it
 * hands it out, so "absent from the server" means either "a peer is about to send the Welcome built
 * on it" or "its owner revoked it" - opposite treatments, and guessing loses a join. A row THIS
 * endpoint deletes was still in the pool, which is the same as never having been handed out.
 *
 * **AND IT MUST BE ONE STATEMENT.** Selecting the rows and then deleting them would reintroduce the
 * race it exists to close: a peer claiming a prekey in between would have it reported as purged,
 * and the client would forget the one private bundle that Welcome needs. `DELETE ... RETURNING`
 * makes the returned set exactly the deleted set. These tests pin the contract that carries that.
 */
describe('DevicesController - a purge that reports what it removed', () => {
  let controller: DevicesController;
  let execute: jest.Mock;
  let deleteCalls: string[];
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  /**
   * A query-builder double that RECORDS the chain, so the test can assert the shape and not only
   * the result. `returning` appearing in the chain is the whole atomicity claim.
   */
  function builder() {
    execute = jest.fn();
    const chain: Record<string, unknown> = {};
    for (const step of ['delete', 'from', 'where', 'returning']) {
      chain[step] = jest.fn(() => {
        deleteCalls.push(step);
        return chain;
      });
    }
    chain.execute = execute;
    return chain;
  }

  beforeEach(async () => {
    deleteCalls = [];
    const chain = builder();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        {
          provide: getRepositoryToken(OneTimeKeyPackage),
          useValue: { createQueryBuilder: jest.fn(() => chain) },
        },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DevicesController);
    log = jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('returns the payloads it deleted, in ONE statement that asked for them back', async () => {
    execute.mockResolvedValue({
      affected: 2,
      raw: [{ keyPackage: 'AAAA' }, { keyPackage: 'BBBB' }],
    });

    const res = await controller.purgeDevicePrekeys('u1', 'd1', 'u1');

    expect(res).toEqual({ status: 'purged', deleted: 2, keyPackages: ['AAAA', 'BBBB'] });
    // `returning` in the chain is what makes the returned set the deleted set. A read followed by
    // a delete would satisfy the assertion above and still be wrong.
    expect(deleteCalls).toContain('returning');
  });

  it('is a clean no-op on an already-empty pool', async () => {
    execute.mockResolvedValue({ affected: 0, raw: [] });

    const res = await controller.purgeDevicePrekeys('u1', 'd1', 'u1');

    expect(res).toEqual({ status: 'purged', deleted: 0, keyPackages: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ACCUSES when rows were deleted but none came back, because that is the leak returning', async () => {
    // A driver that stopped honouring RETURNING would leave the client reclaiming nothing while
    // this still reported a clean purge - the silent return of the very defect this closes. It
    // must not fail the purge, which did its job, but it must not pass unremarked either.
    execute.mockResolvedValue({ affected: 50, raw: [] });

    const res = await controller.purgeDevicePrekeys('u1', 'd1', 'u1');

    expect(res.deleted).toBe(50);
    expect(res.keyPackages).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot reclaim'));
  });

  it('refuses to purge another user device', async () => {
    await expect(controller.purgeDevicePrekeys('victim', 'd1', 'attacker')).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('drops malformed rows rather than handing the client something it cannot decode', async () => {
    execute.mockResolvedValue({
      affected: 3,
      raw: [{ keyPackage: 'AAAA' }, { keyPackage: '' }, {}],
    });

    const res = await controller.purgeDevicePrekeys('u1', 'd1', 'u1');

    expect(res.keyPackages).toEqual(['AAAA']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot reclaim'));
  });
});
