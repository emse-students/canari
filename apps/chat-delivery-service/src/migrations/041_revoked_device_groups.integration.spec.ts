/// <reference types="jest" />

/**
 * MIGRATION 041 AND THE PURGE THAT WRITES IT, AGAINST A REAL POSTGRESQL: the table lands and replays
 * as a no-op, the entity reads and writes it, and the real `INSERT ... SELECT` of
 * `purgeDeviceFootprint` records exactly the KEY groups a REVOKED device held - not its
 * conversations, not a device it never held, nothing for the GC - in the transaction that deletes
 * its rows. The group's end takes the rows with it (`deleteGroupOwnedRows`).
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. The schema before 041 is the entities' own, minus the new table, in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 041_revoked_device_groups
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { MessagingService } from '../services/messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { SeatEviction } from '../entities/seat-eviction.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { RevokedDeviceGroup } from '../entities/revoked-device-group.entity';
import { deleteGroupOwnedRows } from '../utils/group-purge';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '041_revoked_device_groups.sql'), 'utf8');

/** Every table the purge and the group's end touch, as the estate holds them before 041. */
const BEFORE_041 = [
  QueuedMessage,
  QueuedPayload,
  KeyPackage,
  OneTimeKeyPackage,
  GroupMember,
  Group,
  DeviceGroupMembership,
  PushToken,
  RevokedDevice,
  MlsCommitLog,
  MlsGroupInfo,
  GroupInvite,
  GroupMembershipInterval,
  SeatEviction,
  UserDismissedGroup,
];

const KEY_GROUP = '11111111-1111-4111-8111-111111111111';
const SALON_GROUP = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

maybe('migration 041 (dm_revoked_device_groups) against PostgreSQL', () => {
  const schema = `revoked_groups_it_${Date.now()}`;
  const options = { extra: { options: `-c search_path=${schema}` } };
  let admin: Client;
  let ds: DataSource;
  let service: MessagingService;
  const redis = { srem: jest.fn().mockResolvedValue(1) };

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const bindings = async () =>
    (await ds.getRepository(RevokedDeviceGroup).find({ order: { groupId: 'ASC' } })).map(
      (r) => `${r.groupId.slice(0, 1)}:${r.userId}:${r.deviceId}`
    );
  const holds = (userId: string, deviceId: string, groupId: string) =>
    ds
      .getRepository(DeviceGroupMembership)
      .save({ userId, deviceId, groupId, status: 'active' as const });

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    // The estate before 041: every other table, made by the entities themselves.
    const before = new DataSource({
      type: 'postgres',
      url: URL,
      entities: BEFORE_041,
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      ...options,
    });
    await before.initialize();
    await before.synchronize();
    await before.destroy();
    // The one the deploy runs, and the one TypeORM must then read: no synchronize from here on.
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [...BEFORE_041, RevokedDeviceGroup],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      ...options,
    });
    await ds.initialize();
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await q(MIGRATION);
    await q(MIGRATION);

    service = new MessagingService(
      ds.getRepository(QueuedMessage),
      ds.getRepository(GroupMember),
      ds.getRepository(Group),
      ds.getRepository(KeyPackage),
      ds.getRepository(OneTimeKeyPackage),
      ds.getRepository(DeviceGroupMembership),
      ds.getRepository(PushToken),
      ds.getRepository(MlsCommitLog),
      ds.getRepository(MlsGroupInfo),
      ds.getRepository(RevokedDevice),
      redis as unknown as Redis
    );

    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionWorkspaceId") VALUES ($1, true, 3, $2)`,
      [KEY_GROUP, '44444444-4444-4444-8444-444444444444']
    );
    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionChannelId") VALUES ($1, true, 3, $2)`,
      [SALON_GROUP, '55555555-5555-4555-8555-555555555555']
    );
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 3)`, [
      CONVERSATION,
    ]);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    jest.restoreAllMocks();
  }, 60_000);

  beforeEach(async () => {
    await q('DELETE FROM dm_revoked_device_groups');
    await q('DELETE FROM dm_device_group_memberships');
  });

  it('a revocation records the key groups the device held - the community and the salon, never the conversation', async () => {
    await holds('bob', 'b1', KEY_GROUP);
    await holds('bob', 'b1', SALON_GROUP);
    await holds('bob', 'b1', CONVERSATION);
    // Another device of the same person, and another person: neither is the revoked device.
    await holds('bob', 'b2', KEY_GROUP);
    await holds('carol', 'c1', KEY_GROUP);

    const purged = await service.purgeDeviceFootprint('bob', 'b1', { recordKeyGroupsHeld: true });

    expect(purged).toMatchObject({ groupsCleaned: 3, keyGroupsRecorded: 2 });
    expect(await bindings()).toEqual(['1:bob:b1', '2:bob:b1']);
    // In the transaction that took its rows: none is left, and the others are untouched.
    const left: { userId: string; deviceId: string }[] = await q(
      `SELECT "userId", "deviceId" FROM dm_device_group_memberships ORDER BY "userId", "deviceId"`
    );
    expect(left).toEqual([
      { userId: 'bob', deviceId: 'b2' },
      { userId: 'carol', deviceId: 'c1' },
    ]);
  });

  it('records nothing for the stale-device GC, and replays a revocation as a no-op', async () => {
    await holds('dan', 'd1', KEY_GROUP);
    await service.purgeDeviceFootprint('dan', 'd1');
    expect(await bindings()).toEqual([]);

    await holds('erin', 'e1', KEY_GROUP);
    await service.purgeDeviceFootprint('erin', 'e1', { recordKeyGroupsHeld: true });
    // A second revocation of the same id: its rows are gone, and the key is not written twice.
    await holds('erin', 'e1', KEY_GROUP);
    await service.purgeDeviceFootprint('erin', 'e1', { recordKeyGroupsHeld: true });
    expect(await bindings()).toEqual(['1:erin:e1']);
  });

  it("the group's end takes its bindings, and leaves another group's", async () => {
    await holds('fred', 'f1', KEY_GROUP);
    await holds('fred', 'f1', SALON_GROUP);
    await service.purgeDeviceFootprint('fred', 'f1', { recordKeyGroupsHeld: true });

    const counts = await ds.transaction((m) => deleteGroupOwnedRows(m, [SALON_GROUP]));

    expect(counts.revokedDeviceGroups).toBe(1);
    expect(await bindings()).toEqual(['1:fred:f1']);
  });
});
