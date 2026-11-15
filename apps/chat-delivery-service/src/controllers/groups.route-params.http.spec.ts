/// <reference types="jest" />

import type { AddressInfo } from 'net';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ROUTE_PARAMS_GUARD } from '../common/route-params';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import { GroupsController } from './groups.controller';

/**
 * A GROUP ID THAT IS NOT A UUID IS A 400, AND NO QUERY IS BUILT FROM IT.
 *
 * `dm_groups.id` is a Postgres `uuid`, so the id must be judged before a `where` carries it. The
 * real controller and the real global guard, over HTTP; the session guard is replaced by one that
 * counts, to show the declaration is read BEFORE it.
 */
describe('GET mls/groups/:groupId', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const lookups: unknown[] = [];
  let sessionGuardRuns = 0;
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GroupsController],
      providers: [
        ROUTE_PARAMS_GUARD,
        {
          provide: getRepositoryToken(Group),
          useValue: {
            findOne: (query: unknown) => {
              lookups.push(query);
              return Promise.resolve(null);
            },
          },
        },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({
        canActivate: () => {
          sessionGuardRuns += 1;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    app?.getHttpServer().closeAllConnections();
    await app?.close();
  });

  beforeEach(() => {
    lookups.length = 0;
    sessionGuardRuns = 0;
  });

  it.each(['not-a-uuid', 'channel_42', `${ID}0`])(
    'refuses %s with a 400 naming the parameter',
    async (id) => {
      const res = await fetch(`${base}/mls/groups/${id}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain('"groupId"');
      expect(lookups).toEqual([]);
      expect(sessionGuardRuns).toBe(0);
    }
  );

  it('lets a uuid through to the session guard, then to the lookup', async () => {
    const res = await fetch(`${base}/mls/groups/${ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });
    expect(sessionGuardRuns).toBe(1);
    expect(lookups).toEqual([{ where: { id: ID } }]);
  });
});
