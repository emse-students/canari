/// <reference types="jest" />

/**
 * MIGRATION 056 AND "MES NOTES", AGAINST A REAL POSTGRESQL: the column lands on a table shaped as
 * production holds it (a row already there reads `conversation`), the migration replays as a no-op,
 * the CHECK refuses an unknown kind and a self row that is a group or a seed carrier, and the unique
 * partial index keeps ONE live notes conversation per account - through the creation route itself,
 * two devices racing on two connections, where exactly one row lands and the other is answered 409
 * `SELF_CONVERSATION_EXISTS` naming it. A tombstone leaves the index, so a deleted notes conversation
 * can be created again and two erased accounts never collide on `[deleted]`.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. Works in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 056_dm_groups_self_kind
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { Group } from '../entities/group.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { DeviceSignatureKey } from '../entities/device-signature-key.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { SeatEviction } from '../entities/seat-eviction.entity';
import { JoinAskPush } from '../entities/join-ask-push.entity';
import { RevokedDeviceGroup } from '../entities/revoked-device-group.entity';
import { SentFrameReceipt } from '../entities/sent-frame-receipt.entity';
import { UninvitedEntry } from '../entities/uninvited-entry.entity';
import { GroupsController } from '../controllers/groups.controller';
import type { MessagingService } from '../services/messaging.service';
import { writePendingSeats } from '../utils/group-membership';
import { selfConversationUnawareDevices } from '../utils/self-conversation';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '056_dm_groups_self_kind.sql'), 'utf8');

const LEGACY_GROUP = '56565656-5656-4565-8565-565656565656';
const OWNER = 'a1'.repeat(32);
const OTHER_OWNER = 'b2'.repeat(32);

/**
 * `dm_groups` as production holds it before 056 - TypeORM's `synchronize` made it years ago, and the
 * later migrations added columns. Written by hand so the migration, not the entity, adds `kind`.
 */
const PRE_056_TABLE = `
  CREATE TABLE dm_groups (
    id uuid PRIMARY KEY,
    name varchar NULL,
    "imageMediaId" varchar(255) NULL,
    "createdBy" varchar(255) NULL,
    "isGroup" boolean NOT NULL DEFAULT false,
    "distributionWorkspaceId" uuid NULL,
    "distributionChannelId" uuid NULL,
    "activeEpoch" integer NOT NULL DEFAULT 0,
    "seatGeneration" integer NOT NULL DEFAULT 0,
    "epochSeatGeneration" integer NOT NULL DEFAULT 0,
    "deletedAt" timestamp NULL,
    "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now()
  )`;

/** `key_package` before 056 - the columns a creation reads; the migration adds the capability. */
const PRE_056_KEY_PACKAGE = `
  CREATE TABLE key_package (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" varchar(255) NOT NULL,
    "deviceId" varchar NOT NULL,
    "keyPackage" varchar NOT NULL DEFAULT 'kp',
    UNIQUE ("userId", "deviceId")
  )`;

/** The device seats a 409 counts holders in - the columns it reads. */
const DEVICE_SEATS = `
  CREATE TABLE dm_device_group_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" varchar NOT NULL,
    "deviceId" varchar NOT NULL,
    "groupId" uuid NOT NULL,
    status varchar NOT NULL
  )`;

/** The status and refusal of a rejected call, or `null` when it resolved. */
const refusalOf = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (e: { getStatus: () => number; getResponse: () => Record<string, unknown> }) => ({
      status: e.getStatus(),
      ...e.getResponse(),
    })
  );

maybe('migration 056 (dm_groups.kind, one live self conversation) against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `self_kind_it_${Date.now()}`;
  let admin: Client;
  let ds: DataSource;
  /** A second pool on the same schema: the other device's request, on another connection. */
  let other: DataSource;

  const dataSource = () =>
    new DataSource({
      type: 'postgres',
      url: URL,
      // `KeyPackage` for the capability read: its table is the hand-made one below.
      entities: [Group, KeyPackage],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });

  /** The creation route on `source`, its device always addressable and its enrolment landing. */
  const routeOn = (source: DataSource) =>
    new GroupsController(
      source.getRepository(Group),
      // The device and roster tables are not on the creation path; no base was ever published.
      null as never,
      null as never,
      { findOne: async () => null } as never,
      null as unknown as Redis,
      {
        deviceAddressability: async () => ({ ok: true }),
        activateDeviceMembership: async () => ({ ok: true }),
      } as unknown as MessagingService
    );
  const createSelf = (source: DataSource, owner: string, device: string) =>
    routeOn(source).createGroup(
      { name: '', createdBy: owner, isGroup: false, creatorDeviceId: device, kind: 'self' },
      owner
    );
  const liveSelfRows = async (owner: string): Promise<number> => {
    const [row]: { n: string }[] = await ds.query(
      `SELECT COUNT(*) AS n FROM dm_groups WHERE kind = 'self' AND "createdBy" = $1 AND "deletedAt" IS NULL`,
      [owner]
    );
    return Number(row.n);
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = dataSource();
    await ds.initialize();
    await ds.query(PRE_056_TABLE);
    await ds.query(PRE_056_KEY_PACKAGE);
    await ds.query(DEVICE_SEATS);
    await ds.query(
      `INSERT INTO dm_groups (id, name, "isGroup", "createdBy") VALUES ($1, 'Promo', true, $2)`,
      [LEGACY_GROUP, OWNER]
    );
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
    other = dataSource();
    await other.initialize();
    // Every creating device below states the "Mes notes" capability; `dev-old` states nothing.
    for (const [owner, device, version] of [
      [OWNER, 'dev-a', 1],
      [OWNER, 'dev-b', 1],
      [OTHER_OWNER, 'dev-c', 1],
      [OTHER_OWNER, 'dev-old', 0],
    ] as const) {
      await ds.query(
        `INSERT INTO key_package ("userId", "deviceId", "selfConversationVersion") VALUES ($1, $2, $3)`,
        [owner, device, version]
      );
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await other?.destroy();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('reads every existing row as an ordinary conversation, through the entity', async () => {
    const legacy = await ds.getRepository(Group).findOneByOrFail({ id: LEGACY_GROUP });
    expect(legacy.kind).toBe('conversation');
  });

  it('refuses an unknown kind, and a self row that is a group chat or a seed carrier', async () => {
    const insert = (kind: string, isGroup: boolean, workspace: string | null = null) =>
      ds.query(
        `INSERT INTO dm_groups (id, kind, "isGroup", "distributionWorkspaceId", "createdBy")
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [kind, isGroup, workspace, OTHER_OWNER]
      );

    await expect(insert('notes', false)).rejects.toThrow(/chk_dm_groups_kind/);
    await expect(insert('self', true)).rejects.toThrow(/chk_dm_groups_kind/);
    await expect(insert('self', false, LEGACY_GROUP)).rejects.toThrow(/chk_dm_groups_kind/);
    expect(await liveSelfRows(OTHER_OWNER)).toBe(0);
  });

  it('two devices creating at the same instant: one row lands, the other is told which one', async () => {
    const [a, b] = await Promise.all([
      refusalOf(createSelf(ds, OWNER, 'dev-a')),
      refusalOf(createSelf(other, OWNER, 'dev-b')),
    ]);

    const refusals = [a, b].filter((r) => r !== null);
    expect(refusals).toHaveLength(1);
    expect(await liveSelfRows(OWNER)).toBe(1);
    const [live] = await ds.query(
      `SELECT id, "isGroup", name FROM dm_groups WHERE kind = 'self' AND "createdBy" = $1`,
      [OWNER]
    );
    expect(live).toMatchObject({ isGroup: false, name: null });
    // Neither device's seat is written here (the enrolment is stubbed): no other device holds it.
    expect(refusals[0]).toMatchObject({
      status: 409,
      code: 'SELF_CONVERSATION_EXISTS',
      groupId: live.id,
      otherHolders: 0,
    });
  });

  it('a 409 counts the OTHER devices holding the live one - never the asking device', async () => {
    const [live] = await ds.query(
      `SELECT id FROM dm_groups WHERE kind = 'self' AND "createdBy" = $1 AND "deletedAt" IS NULL`,
      [OWNER]
    );
    await ds.query(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, 'dev-a', $2, 'active'), ($1, 'dev-b', $2, 'active'), ($1, 'dev-gone', $2, 'active')`,
      [OWNER, live.id]
    );
    // dev-gone has no key package: revoked or erased, it holds nothing anyone can be Welcomed from.
    await expect(refusalOf(createSelf(ds, OWNER, 'dev-a'))).resolves.toMatchObject({
      status: 409,
      groupId: live.id,
      otherHolders: 1,
    });
    await ds.query(`DELETE FROM dm_device_group_memberships WHERE "groupId" = $1`, [live.id]);
  });

  it('refuses a creation from a device whose build does not state the capability', async () => {
    await expect(refusalOf(createSelf(ds, OTHER_OWNER, 'dev-old'))).resolves.toMatchObject({
      status: 403,
      code: 'SELF_CONVERSATION_DEVICE_UNAWARE',
      deviceIds: ['dev-old'],
    });
    expect(await liveSelfRows(OTHER_OWNER)).toBe(0);
  });

  it('answers the created row as a self conversation, and the group read carries the kind', async () => {
    const created = await createSelf(ds, OTHER_OWNER, 'dev-c');
    expect(created).toMatchObject({ kind: 'self', isGroup: false });

    const read = await routeOn(ds).getGroup(created.groupId);
    expect(read).toMatchObject({ groupId: created.groupId, kind: 'self' });
    expect(read).not.toHaveProperty('createdBy');
  });

  it('a tombstone leaves the index: deleted, it can be created again, and erased owners never collide', async () => {
    await ds.query(
      `UPDATE dm_groups SET "deletedAt" = now() WHERE kind = 'self' AND "createdBy" = $1`,
      [OWNER]
    );

    await expect(createSelf(ds, OWNER, 'dev-a')).resolves.toMatchObject({ kind: 'self' });

    // The erasure tombstones the one-person roster, then rewrites the creator to `[deleted]`.
    await ds.query(`UPDATE dm_groups SET "deletedAt" = now() WHERE kind = 'self'`);
    await expect(
      ds.query(`UPDATE dm_groups SET "createdBy" = '[deleted]' WHERE kind = 'self'`)
    ).resolves.toBeDefined();
    expect(await liveSelfRows('[deleted]')).toBe(0);
  });

  it('refuses a self creation with no authenticated caller or no device, writing nothing', async () => {
    const before: { n: string }[] = await ds.query(`SELECT COUNT(*) AS n FROM dm_groups`);

    await expect(
      refusalOf(
        routeOn(ds).createGroup({ name: '', createdBy: OWNER, isGroup: false, kind: 'self' }, OWNER)
      )
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      refusalOf(
        routeOn(ds).createGroup(
          { name: '', createdBy: OWNER, creatorDeviceId: 'dev-a', kind: 'self' },
          undefined
        )
      )
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      refusalOf(
        routeOn(ds).createGroup(
          { name: '', createdBy: OWNER, creatorDeviceId: 'dev-a', kind: 'notes' },
          OWNER
        )
      )
    ).resolves.toMatchObject({ status: 400 });

    const after: { n: string }[] = await ds.query(`SELECT COUNT(*) AS n FROM dm_groups`);
    expect(after[0].n).toBe(before[0].n);
  });
});

/**
 * THE GATES OF "MES NOTES", on every table the service holds (`synchronize`, then 056 replayed as on
 * production): a device whose build does not state the capability gets no seat in a self group; the
 * one predicate every door asks names exactly those devices and nothing in an ordinary group; a
 * delete that does not say it knows the kind is refused; and a 409 that found nobody else holding the
 * live group lets the asking device END it and write a new one - but never while another device
 * holds it, re-read under the seat lock.
 */
maybe('"Mes notes" gates against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `self_gates_it_${Date.now()}`;
  let admin: Client;
  let ds: DataSource;
  const pipeline = () => {
    const p = {
      xadd: () => p,
      xtrim: () => p,
      expire: () => p,
      exec: async () => [],
    };
    return p;
  };
  const redis = {
    del: async () => 0,
    srem: async () => 0,
    hdel: async () => 0,
    publish: async () => 0,
    pipeline,
  };

  const ME = 'c3'.repeat(32);
  const route = () =>
    new GroupsController(
      ds.getRepository(Group),
      ds.getRepository(DeviceGroupMembership),
      ds.getRepository(GroupMember),
      ds.getRepository(MlsGroupInfo),
      redis as unknown as Redis,
      {
        deviceAddressability: async () => ({ ok: true }),
        activateDeviceMembership: async () => ({ ok: true }),
      } as unknown as MessagingService
    );
  const createSelf = (device: string, replaceUnheld = false) =>
    route().createGroup(
      {
        name: '',
        createdBy: ME,
        isGroup: false,
        creatorDeviceId: device,
        kind: 'self',
        replaceUnheld,
      },
      ME
    );
  const registerDevice = (deviceId: string, version: number) =>
    ds.query(
      `INSERT INTO key_package ("userId", "deviceId", "keyPackage", "selfConversationVersion")
       VALUES ($1, $2, 'kp', $3)`,
      [ME, deviceId, version]
    );
  const live = async (): Promise<string | null> => {
    const [row] = await ds.query(
      `SELECT id FROM dm_groups WHERE kind = 'self' AND "createdBy" = $1 AND "deletedAt" IS NULL`,
      [ME]
    );
    return row?.id ?? null;
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
        UserDismissedGroup,
        Group,
        PinVerifier,
        DeviceGroupMembership,
        PushToken,
        RevokedDevice,
        GroupInvite,
        MlsCommitLog,
        MlsGroupInfo,
        DeviceSignatureKey,
        NotificationPreference,
        GroupMembershipInterval,
        SeatEviction,
        JoinAskPush,
        RevokedDeviceGroup,
        SentFrameReceipt,
        UninvitedEntry,
      ],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    await ds.query(MIGRATION);
    await registerDevice('phone', 1);
    await registerDevice('laptop', 1);
    await registerDevice('old-tablet', 0);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('seats every device of the account EXCEPT one whose build does not know the kind', async () => {
    const { groupId } = await createSelf('phone');
    await ds.getRepository(GroupMember).insert({ groupId, userId: ME });

    await expect(
      writePendingSeats(ds.manager, groupId, ME, ['laptop', 'old-tablet'], false)
    ).resolves.toBe('written');
    const seats: { deviceId: string }[] = await ds.query(
      `SELECT "deviceId" FROM dm_device_group_memberships WHERE "groupId" = $1 ORDER BY "deviceId"`,
      [groupId]
    );
    expect(seats.map((r) => r.deviceId)).toEqual(['laptop']);

    expect(
      await selfConversationUnawareDevices(ds.manager, { kind: 'self' }, [
        { userId: ME, deviceId: 'laptop' },
        { userId: ME, deviceId: 'old-tablet' },
        { userId: ME, deviceId: 'never-registered' },
      ])
    ).toEqual([
      { userId: ME, deviceId: 'old-tablet' },
      { userId: ME, deviceId: 'never-registered' },
    ]);
  });

  it('asks nothing of an ordinary group', async () => {
    const [ordinary] = await ds.query(
      `INSERT INTO dm_groups (id, "isGroup", "createdBy") VALUES (gen_random_uuid(), true, $1) RETURNING id`,
      [ME]
    );
    const row = await ds.getRepository(Group).findOneByOrFail({ id: ordinary.id });
    expect(
      await selfConversationUnawareDevices(ds.manager, row, [
        { userId: ME, deviceId: 'old-tablet' },
      ])
    ).toEqual([]);
  });

  it('refuses a delete of "Mes notes" that does not say it knows the kind', async () => {
    const groupId = (await live())!;
    await expect(refusalOf(route().deleteGroup(groupId, ME))).resolves.toMatchObject({
      status: 403,
      code: 'SELF_CONVERSATION_KIND_UNSTATED',
    });
    expect(await live()).toBe(groupId);
  });

  it('replaceUnheld never ends a group another device holds', async () => {
    const groupId = (await live())!;
    await ds.query(
      `UPDATE dm_device_group_memberships SET status = 'active' WHERE "groupId" = $1 AND "deviceId" = 'laptop'`,
      [groupId]
    );

    await expect(refusalOf(createSelf('phone', true))).resolves.toMatchObject({
      status: 409,
      groupId,
      otherHolders: 1,
    });
    expect(await live()).toBe(groupId);
  });

  it('replaceUnheld ends a group no other device holds, and writes a new one', async () => {
    const groupId = (await live())!;
    // The laptop's seat only pending: no Welcome can come from it.
    await ds.query(
      `UPDATE dm_device_group_memberships SET status = 'pending' WHERE "groupId" = $1 AND "deviceId" = 'laptop'`,
      [groupId]
    );

    const created = await createSelf('phone', true);

    expect(created.groupId).not.toBe(groupId);
    expect(await live()).toBe(created.groupId);
    const [ended] = await ds.query(`SELECT "deletedAt" FROM dm_groups WHERE id = $1`, [groupId]);
    expect(ended.deletedAt).not.toBeNull();
  });
});
