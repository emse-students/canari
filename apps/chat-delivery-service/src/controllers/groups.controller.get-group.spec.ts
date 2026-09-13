/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GroupsController } from './groups.controller';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `GET /mls/groups/:groupId` IS THE FIRST CALL OF EVERY RECOVERY PASS, and what it answers decides
 * whether the other three are worth making.
 *
 * A device with no local MLS state can only enter a group by external commit, and the commit gate
 * accepts a base whose epoch EQUALS the group's active epoch and nothing else. So while
 * `baseEpoch < activeEpoch` the join is refused, every time, whoever asks - and only a member
 * holding the tree can mint a new base. `activeEpoch` is a column of the row and was already on the
 * wire here; the published base lives in `mls_group_info` and was not, so a refused device had no
 * way to see the two numbers converge except by attempting the join again, once a minute, for ever.
 *
 * Measured on production 2026-09-12: one device ran the full pass against group `4f87267a` for at
 * least twenty-seven consecutive minutes and the server answered `NO_PEER_ONLINE members=1` to
 * every base-refresh ask - its only other member had not connected since 2026-08-03. Three groups
 * on that estate had been stale since 2026-08-29, 08-30 and 08-31.
 */
describe('GroupsController.getGroup - the two epochs travel with the row', () => {
  let controller: GroupsController;
  let groupRepo: { findOne: jest.Mock };
  let groupInfoRepo: { findOne: jest.Mock };

  const ROW = {
    id: 'g-1',
    name: 'Amis',
    isGroup: true,
    activeEpoch: 284,
    deletedAt: null,
  };

  beforeEach(async () => {
    groupRepo = { findOne: jest.fn() };
    groupInfoRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupsController],
      providers: [
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: groupInfoRepo },
        { provide: 'REDIS_CLIENT', useValue: {} },
        // `createGroup` enrols the creator through the ONE `pending -> active` writer since
        // 2026-09-13, so the controller depends on it. Nothing here reads a group by creating one.
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(GroupsController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('carries the published base epoch beside the active one', async () => {
    groupRepo.findOne.mockResolvedValue(ROW);
    groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g-1', baseEpoch: 283 });

    const got = await controller.getGroup('g-1');

    expect(got).toMatchObject({ groupId: 'g-1', activeEpoch: 284, baseEpoch: 283 });
  });

  it('answers null - not zero - when no base has ever been published', async () => {
    // AND THE DIFFERENCE IS THE WHOLE POINT. `0` would read as "a base exists and is 284 epochs
    // behind", which is a stale base and asks for a republish; nothing has been lost here, and the
    // answer to it is a Welcome from a member. Both mistakes are one line and neither fails loudly.
    groupRepo.findOne.mockResolvedValue(ROW);
    groupInfoRepo.findOne.mockResolvedValue(null);

    const got = await controller.getGroup('g-1');

    expect(got).toMatchObject({ groupId: 'g-1', activeEpoch: 284, baseEpoch: null });
  });

  it('does not read the base of a group that does not exist', async () => {
    // An absent row is the answer, and it is a different answer from a stale base: the client
    // separates "confirmed absent" (purge the local phantom) from "cannot be read" (wait a round),
    // and a lookup here would cost a query on every 404 without changing either.
    groupRepo.findOne.mockResolvedValue(null);

    const got = await controller.getGroup('g-missing');

    expect(got).toBeNull();
    expect(groupInfoRepo.findOne).not.toHaveBeenCalled();
  });
});
