/**
 * THE ARRIVAL FLOOR OF `GET mls/commits/:groupId/accepted-at`, AGAINST A REAL POSTGRESQL.
 *
 * A member is handed the time of the commit that admitted them and of every later one, never of a
 * commit older than their arrival (`commitFloorOf`). The unit spec stubs the `createdAt` comparison,
 * so it cannot say what the database answers at the one boundary that matters - two rows written in
 * the SAME transaction share `now()` - nor which stretch a re-joined member is floored by. These
 * cases do (review of #2890, LOW-2):
 *
 * - a key-distribution device row and the commit that admitted it, written in one transaction: the
 *   admitting commit is answered, the one before it refused;
 * - a member who left and came back: a commit of the earlier stretch is refused;
 * - the arrival is the OPEN stretch's `admittedAt ?? joinedAt`, never a closed one's.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads;
 * CI's `test-chat-delivery-integration` sets it and refuses a skip. Locally:
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- commit-time.integration
 *
 * A throwaway schema, created before the DataSource initializes and dropped at the end. No Redis
 * path is reached.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { MessagingService } from './messaging.service';
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

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const dir = join(__dirname, '..', 'migrations');
const MIGRATION_036 = readFileSync(join(dir, '036_seat_evictions.sql'), 'utf8');
const MIGRATION_038 = readFileSync(join(dir, '038_group_member_awaiting_admission.sql'), 'utf8');
const MIGRATION_039 = readFileSync(join(dir, '039_departure_seat_generation.sql'), 'utf8');

/** A key-distribution group (a community's), whose seats are per device and keep no stretch. */
const KEY_GROUP = '00000000-0000-4000-8000-0000000000c1';
/** A group conversation, whose members hold membership stretches. */
const GROUP = '00000000-0000-4000-8000-0000000000c2';
const ME = { userId: 'member', deviceId: 'dev-m' };

/** An instant `h` hours into 2026-11-01, UTC. */
const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h));

/** The HTTP status of a rejected call, or `'answered'` with its instant. */
const outcome = (call: Promise<{ acceptedAt: string | null }>) =>
  call.then(
    (r) => r.acceptedAt,
    (e: { getStatus: () => number }) => e.getStatus()
  );

maybe('the accepted-at arrival floor (PostgreSQL)', () => {
  const schema = `commit_time_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: MessagingService;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Logs the commit built on `base` in `groupId`, accepted at `createdAt`. */
  const commitAt = (groupId: string, base: number, createdAt: Date) =>
    q(
      `INSERT INTO mls_commit_log ("groupId", "baseEpoch", commit, "createdAt") VALUES ($1, $2, 'c', $3)`,
      [groupId, base, createdAt]
    );
  /** A stretch of membership of ME in GROUP. */
  const stretch = (joinedAt: Date, leftAt: Date | null, admittedAt: Date | null = null) =>
    q(
      `INSERT INTO dm_group_membership_intervals ("groupId", "userId", "joinedAt", "leftAt", "admittedAt") VALUES ($1, $2, $3, $4, $5)`,
      [GROUP, ME.userId, joinedAt, leftAt, admittedAt]
    );
  const ask = (groupId: string, base: number, deviceId: string | null = ME.deviceId) =>
    outcome(service.getCommitAcceptedAt(groupId, base, ME.userId, deviceId ?? undefined));

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
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
      ],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    await q(MIGRATION_036);
    await q(MIGRATION_038);
    await q(MIGRATION_039);
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
      {} as unknown as Redis
    );
    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionChannelId") VALUES ($1, true, 9, gen_random_uuid())`,
      [KEY_GROUP]
    );
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 9)`, [GROUP]);
  });

  beforeEach(async () => {
    await q(`DELETE FROM mls_commit_log`);
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM dm_group_members`);
    await q(`DELETE FROM dm_group_membership_intervals`);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('a key-group device row written in the SAME transaction as its admitting commit is handed that commit, and nothing older', async () => {
    await commitAt(KEY_GROUP, 3, at(1));
    // The commit gate's transaction: the admitting commit's log row and the device row it admits,
    // both stamped by the one `now()` of that transaction.
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO mls_commit_log ("groupId", "baseEpoch", commit) VALUES ($1, 4, 'c')`,
        [KEY_GROUP]
      );
      await m.query(
        `INSERT INTO dm_device_group_memberships ("groupId", "userId", "deviceId", status) VALUES ($1, $2, $3, 'active')`,
        [KEY_GROUP, ME.userId, ME.deviceId]
      );
    });
    await q(
      `INSERT INTO mls_commit_log ("groupId", "baseEpoch", commit, "createdAt") VALUES ($1, 5, 'c', now() + interval '1 minute')`,
      [KEY_GROUP]
    );

    expect(typeof (await ask(KEY_GROUP, 4))).toBe('string');
    expect(typeof (await ask(KEY_GROUP, 5))).toBe('string');
    expect(await ask(KEY_GROUP, 3)).toBe(403);
    // FAILS CLOSED: a key group asked without the device that would anchor the floor.
    expect(await ask(KEY_GROUP, 5, null)).toBe(400);
  });

  it('a member who left and came back is refused the commits of the earlier stretch', async () => {
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      ME.userId,
    ]);
    await stretch(at(1), at(3));
    await stretch(at(6), null);
    await commitAt(GROUP, 2, at(2)); // inside the first stretch
    await commitAt(GROUP, 4, at(4)); // while they were out
    await commitAt(GROUP, 5, at(5)); // the commit that admitted them back
    await commitAt(GROUP, 6, at(7));

    expect(await ask(GROUP, 2)).toBe(403);
    expect(await ask(GROUP, 4)).toBe(403);
    expect(await ask(GROUP, 5)).toBe(at(5).toISOString());
    expect(await ask(GROUP, 6)).toBe(at(7).toISOString());
  });

  it("arrival is the OPEN stretch's admittedAt, ahead of its joinedAt and of any closed stretch", async () => {
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      ME.userId,
    ]);
    // A closed stretch reaching back to hour 0 must not lower the floor.
    await stretch(at(0), at(1));
    // Admitted by a commit at hour 3, enrolled at hour 6.
    await stretch(at(6), null, at(3));
    await commitAt(GROUP, 1, at(0));
    await commitAt(GROUP, 2, at(2));
    await commitAt(GROUP, 3, at(3)); // the commit that admitted them
    await commitAt(GROUP, 4, at(5));

    expect(await ask(GROUP, 1)).toBe(403);
    expect(await ask(GROUP, 2)).toBe(403);
    expect(await ask(GROUP, 3)).toBe(at(3).toISOString());
    expect(await ask(GROUP, 4)).toBe(at(5).toISOString());
  });
});
