/// <reference types="jest" />

import { InvitationsController } from './invitations.controller';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';

/**
 * THE THREE ROUTES THAT TAKE A DEVICE OUT OF A GROUP TAKE ITS QUEUED WELCOMES WITH IT, in the
 * transaction that deletes its rows (`endDeviceMemberships`): a device pulls its queue whatever the
 * roster says, so a Welcome left behind would let it back into the epoch it was built for.
 */
describe('InvitationsController - a device leaving a group', () => {
  let txDeletes: Array<{ entity: unknown; where: unknown }>;
  let deviceGroupRepo: {
    find: jest.Mock;
    delete: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let queuedRepo: { delete: jest.Mock };
  let controller: InvitationsController;

  beforeEach(() => {
    txDeletes = [];
    deviceGroupRepo = {
      find: jest.fn().mockResolvedValue([{ groupId: 'g-1' }, { groupId: 'g-2' }]),
      delete: jest.fn(),
      manager: {
        transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
          cb({
            getRepository: (entity: unknown) => ({
              delete: (where: unknown) => {
                txDeletes.push({ entity, where });
                return Promise.resolve({ affected: 1 });
              },
            }),
          })
        ),
      },
    };
    queuedRepo = { delete: jest.fn() };
    const redis = { srem: jest.fn().mockResolvedValue(1) };
    controller = new InvitationsController(
      deviceGroupRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      queuedRepo as never,
      redis as never,
      {} as never
    );
  });

  /** Nothing was deleted outside the transaction, where a failure between two deletes splits them. */
  const onlyInTheTransaction = () => {
    expect(deviceGroupRepo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(deviceGroupRepo.delete).not.toHaveBeenCalled();
    expect(queuedRepo.delete).not.toHaveBeenCalled();
  };

  it("DELETE device-memberships/:user/:device/:group takes that group's Welcomes for the device", async () => {
    await controller.deleteDeviceMembership('bob', 'b1', 'g-1');

    expect(txDeletes).toEqual([
      {
        entity: QueuedMessage,
        where: { recipientId: 'bob', deviceId: 'b1', groupId: 'g-1', isWelcome: true },
      },
      { entity: DeviceGroupMembership, where: { userId: 'bob', deviceId: 'b1', groupId: 'g-1' } },
    ]);
    onlyInTheTransaction();
  });

  it("force_leave takes that group's Welcomes for the device", async () => {
    await controller.forceLeave('g-1', { deviceId: 'b1' }, 'bob');

    expect(txDeletes).toEqual([
      {
        entity: QueuedMessage,
        where: { recipientId: 'bob', deviceId: 'b1', groupId: 'g-1', isWelcome: true },
      },
      { entity: DeviceGroupMembership, where: { userId: 'bob', deviceId: 'b1', groupId: 'g-1' } },
    ]);
    onlyInTheTransaction();
  });

  it('DELETE device-memberships/:user/:device takes every Welcome queued for the device', async () => {
    await controller.deleteAllDeviceMemberships('bob', 'b1');

    expect(txDeletes).toEqual([
      { entity: QueuedMessage, where: { recipientId: 'bob', deviceId: 'b1', isWelcome: true } },
      { entity: DeviceGroupMembership, where: { userId: 'bob', deviceId: 'b1' } },
    ]);
    onlyInTheTransaction();
  });
});
