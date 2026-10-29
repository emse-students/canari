/**
 * A KEY-GROUP FRAME STORED ONCE, AGAINST A REAL POSTGRESQL - the send, the pull, the ACK, the device
 * purge, the retention and the collector, through the service's own methods and SQL.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, which CI's `test-chat-delivery-integration` job sets (and which
 * refuses a skip); without it the file reports as skipped rather than passing. It builds its own throwaway schema (the
 * entities through `synchronize`, and migration 034 against a pre-034 table), so it needs nothing
 * else and touches nothing else. Redis is a stub: every device is OFFLINE, so every record is kept
 * for the pull, and Firebase is not initialised, so nothing is pushed.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- queued-payload.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource, type Repository, type ObjectLiteral, type EntityTarget } from 'typeorm';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { Group } from '../entities/group.entity';
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
import { RevokedDeviceGroup } from '../entities/revoked-device-group.entity';
import { MessagingService } from '../services/messaging.service';
import { AppController } from '../app.controller';
import { tombstoneGroups } from './group-purge';
import { PAYLOAD_RELATION, materializeDeliveries } from './queued-payload';
import { mlsFrame } from '../testing/mlsFrameFixture';
import { PENDING_FETCH_CHUNK_ROWS, RETENTION_WINDOW_MS } from '../retention.constants';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '034_queued_payload.sql'),
  'utf8'
);

/**
 * The migration's statements, one by one, as psql sends them: the deploy feeds the file to psql on
 * stdin with no `--single-transaction` (`infrastructure/lib/migrations.sh`), so each statement
 * commits on its own - which `CREATE INDEX CONCURRENTLY` requires. One query string would run as
 * ONE implicit transaction and refuse it. Splits on a `;` ending a line, outside a `$$` body.
 */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inBody = false;
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) && !inBody) continue;
    current += `${line}\n`;
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBody = !inBody;
    if (!inBody && /;\s*$/.test(line)) {
      out.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Applies the migration over ONE session, statement by statement, as the deploy's psql does. */
async function applyMigration(ds: DataSource): Promise<void> {
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    for (const statement of statements(MIGRATION)) await runner.query(statement);
  } finally {
    await runner.release();
  }
}

/** The writer's switch, as the deploy writes it into the environment. */
const SWITCH = 'QUEUED_PAYLOAD_SHARED_WRITES';

/** The service's entities, as `AppModule` registers them. */
const ENTITIES = [
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
  RevokedDeviceGroup,
];

/** A throwaway schema on the test database, dropped afterwards. */
async function schemaSource(schema: string, synchronize: boolean): Promise<DataSource> {
  const admin = new DataSource({ type: 'postgres', url: URL });
  await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.destroy();
  const ds = new DataSource({
    type: 'postgres',
    url: URL,
    entities: synchronize ? ENTITIES : [],
    synchronize,
    extra: { options: `-c search_path=${schema}` },
  });
  await ds.initialize();
  return ds;
}

maybe('migration 034 (queued_payload) against PostgreSQL', () => {
  const schema = `payload_mig_it_${Date.now()}`;
  let ds: DataSource;

  beforeAll(async () => {
    ds = await schemaSource(schema, false);
    // The queue as both estates hold it before 034, with one row in it.
    await ds.query(
      `CREATE TABLE queued_message (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         "recipientId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL, proto varchar,
         "groupId" uuid, "createdAt" timestamp NOT NULL DEFAULT now())`
    );
    await ds.query(
      `INSERT INTO queued_message ("recipientId", "deviceId", proto) VALUES ('u', 'd', 'T0xE'),
         ('u', 'd', 'T0xF')`
    );
    // A CONCURRENT build that failed, as the lock timeout can fail it: an INVALID index left under
    // the migration's own name (here a unique build over two rows sharing a device).
    const leftover = await ds
      .query(
        `CREATE UNIQUE INDEX CONCURRENTLY "IDX_queued_message_payloadId" ON queued_message ("deviceId")`
      )
      .then(
        () => 'built',
        (e: unknown) => String(e)
      );
    if (!/duplicate key|could not create unique index/i.test(leftover)) {
      throw new Error(`the unique build was meant to fail and leave an INVALID index: ${leftover}`);
    }
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await applyMigration(ds);
    await applyMigration(ds);
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  }, 60_000);

  it('leaves the existing rows exactly as they were: inline proto, no payload', async () => {
    const rows = await ds.query(`SELECT proto, "payloadId" FROM queued_message ORDER BY proto`);
    expect(rows).toEqual([
      { proto: 'T0xE', payloadId: null },
      { proto: 'T0xF', payloadId: null },
    ]);
  });

  it('creates the payload table and both lookup indexes', async () => {
    const idx: { indexname: string }[] = await ds.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
      [schema]
    );
    expect(idx.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(['IDX_queued_message_payloadId', 'IDX_queued_payload_groupId'])
    );
  });

  it('replaces the INVALID leftover with a VALID, PARTIAL index on payloadId', async () => {
    const [index] = await ds.query(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i WHERE i.indexrelid = to_regclass('"IDX_queued_message_payloadId"')`
    );
    expect(index.valid).toBe(true);
    expect(index.def).toContain('("payloadId")');
    expect(index.def).toContain('WHERE ("payloadId" IS NOT NULL)');
    expect(index.def).not.toContain('UNIQUE');
  });
});

maybe('a key-group frame stored once, against PostgreSQL', () => {
  const schema = `payload_it_${Date.now()}`;
  let ds: DataSource;
  let service: MessagingService;
  let app: AppController;
  let repo: <T extends ObjectLiteral>(e: EntityTarget<T>) => Repository<T>;

  const KEY_GROUP = '00000000-0000-4000-8000-0000000000a1';
  const DM_GROUP = '00000000-0000-4000-8000-0000000000b2';
  const SENDER = { userId: 'u-sender', deviceId: 'web-sender' };
  /** Five recipient seats on four accounts: `u-1` has two devices. */
  const SEATS = [
    { userId: 'u-1', deviceId: 'web-1a' },
    { userId: 'u-1', deviceId: 'tauri-1b' },
    { userId: 'u-2', deviceId: 'web-2' },
    { userId: 'u-3', deviceId: 'web-3' },
    { userId: 'u-4', deviceId: 'web-4' },
  ];

  const pipeline = () => {
    const p = {
      xadd: () => p,
      xtrim: () => p,
      expire: () => p,
      exec: async () => [
        [null, '1-0'],
        [null, 0],
        [null, 1],
      ],
    };
    return p;
  };
  const redis = {
    exists: jest.fn(async () => 0),
    sadd: jest.fn(async () => 0),
    // Every live seat is already in the routing set: the send's route repair has nothing to add.
    smismember: jest.fn(async (_key: string, ...members: string[]) => members.map(() => 1)),
    srem: jest.fn(async () => 0),
    hdel: jest.fn(async () => 0),
    publish: jest.fn(async () => 0),
    del: jest.fn(async () => 0),
    pipeline,
  };

  const count = async (table: string, where = 'TRUE') =>
    Number((await ds.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0].n);

  /** One application frame from the sender into `groupId`, with a distinct ciphertext. */
  let sequence = 0;
  const send = (groupId: string, extra: Record<string, unknown> = {}) =>
    service.sendMessage(
      {
        proto: mlsFrame(2, `frame-${++sequence}`, 0n),
        groupId,
        senderId: SENDER.userId,
        senderDeviceId: SENDER.deviceId,
        ...extra,
      },
      SENDER.userId
    );

  const pull = (seat: { userId: string; deviceId: string }) =>
    service.fetchMessages(seat.userId, seat.deviceId, seat.userId, undefined);

  /** The service as it boots under `QUEUED_PAYLOAD_SHARED_WRITES=<writes>`. */
  const boot = (writes: 'true' | 'false'): MessagingService => {
    const saved = process.env[SWITCH];
    process.env[SWITCH] = writes;
    try {
      return new MessagingService(
        repo(QueuedMessage),
        repo(GroupMember),
        repo(Group),
        repo(KeyPackage),
        repo(OneTimeKeyPackage),
        repo(DeviceGroupMembership),
        repo(PushToken),
        repo(MlsCommitLog),
        repo(MlsGroupInfo),
        repo(RevokedDevice),
        redis as never
      );
    } finally {
      if (saved === undefined) delete process.env[SWITCH];
      else process.env[SWITCH] = saved;
    }
  };

  beforeAll(async () => {
    ds = await schemaSource(schema, true);
    repo = (e) => ds.getRepository(e);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // The writer ON: what every test below exercises unless it boots its own service OFF.
    service = boot('true');
    app = new AppController(
      repo(QueuedMessage),
      repo(KeyPackage),
      repo(OneTimeKeyPackage),
      repo(Group),
      repo(GroupMember),
      repo(DeviceGroupMembership),
      repo(RevokedDevice),
      repo(PushToken),
      repo(MlsGroupInfo),
      repo(MlsCommitLog),
      redis as never,
      service
    );
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  }, 60_000);

  beforeEach(async () => {
    await ds.query(
      `TRUNCATE queued_message, queued_payload, dm_groups, dm_device_group_memberships, key_package`
    );
    await repo(Group).save([
      {
        id: KEY_GROUP,
        isGroup: true,
        distributionWorkspaceId: '00000000-0000-4000-8000-00000000c0de',
      },
      { id: DM_GROUP, isGroup: false },
    ]);
    for (const groupId of [KEY_GROUP, DM_GROUP]) {
      await repo(DeviceGroupMembership).save(
        [SENDER, ...SEATS].map((s) => ({ ...s, groupId, status: 'active' as const }))
      );
    }
    await repo(KeyPackage).save([SENDER, ...SEATS].map((s) => ({ ...s, keyPackage: 'a3A=' })));
  });

  it('stores N seats as ONE payload row and N delivery records with no ciphertext of their own', async () => {
    const result = await send(KEY_GROUP);

    expect(result.queued).toBe(5);
    expect(await count('queued_payload')).toBe(1);
    expect(await count('queued_message')).toBe(5);
    expect(await count('queued_message', `proto IS NULL AND "payloadId" IS NOT NULL`)).toBe(5);
  });

  it('with the writer OFF (the shipped default), writes the same fan-out inline, one copy per seat', async () => {
    const off = boot('false');

    const result = await off.sendMessage(
      {
        proto: mlsFrame(2, `frame-${++sequence}`, 0n),
        groupId: KEY_GROUP,
        senderId: SENDER.userId,
        senderDeviceId: SENDER.deviceId,
      },
      SENDER.userId
    );

    expect(result.queued).toBe(5);
    expect(await count('queued_payload')).toBe(0);
    expect(await count('queued_message', `proto IS NOT NULL AND "payloadId" IS NULL`)).toBe(5);
    // And the readers serve those rows exactly as they serve a shared one.
    expect(
      (await off.fetchMessages(SEATS[0].userId, SEATS[0].deviceId, SEATS[0].userId, undefined))
        .length
    ).toBe(1);
  });

  it('withholds a record whose payload is gone - never an empty frame a device would ACK', async () => {
    await send(KEY_GROUP);
    await ds.query(`DELETE FROM queued_payload`);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    expect(await pull(SEATS[0])).toEqual([]);
    // Still queued: the record is the evidence, and only an ACK or the retention may take it.
    expect(await count('queued_message')).toBe(5);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('MISSING payload');
    error.mockRestore();
  });

  it('pages a createdAt tie larger than a chunk without repeating or skipping a row', async () => {
    // One instant for every row, more rows than two chunks: only the `q.id` tiebreak makes the
    // OFFSET pages a partition of the queue. A quiet table here happens to repeat its tie order
    // (measured: this passes without the tiebreak too), so the test that FAILS without it is the
    // order-honest fake of `messaging.pending-page.spec.ts`; this one pins the real SQL end to end.
    const at = new Date('2026-10-22T10:00:00.000Z');
    const rows = Array.from({ length: PENDING_FETCH_CHUNK_ROWS * 2 + 7 }, (_, i) => ({
      recipientId: SEATS[0].userId,
      deviceId: SEATS[0].deviceId,
      groupId: KEY_GROUP,
      proto: `cm93LQ${i}`,
      createdAt: at,
    }));
    await repo(QueuedMessage).save(rows, { chunk: 50 });
    // `@CreateDateColumn` writes its own instant on insert: put them all on the same one.
    await ds.query(`UPDATE queued_message SET "createdAt" = $1`, [at]);

    const page = await service.fetchMessages(
      SEATS[0].userId,
      SEATS[0].deviceId,
      SEATS[0].userId,
      undefined,
      1000
    );

    const ids = page.map((r) => r.id);
    expect(ids).toHaveLength(rows.length);
    expect(new Set(ids).size).toBe(rows.length);
  });

  it('serves a push fetch by record id with the shared ciphertext (the fetch-proto read)', async () => {
    await send(KEY_GROUP);
    const [{ id }] = await ds.query(`SELECT id FROM queued_message LIMIT 1`);
    const [{ proto }] = await ds.query(`SELECT proto FROM queued_payload`);

    const row = await repo(QueuedMessage).findOne({ where: { id }, relations: PAYLOAD_RELATION });
    materializeDeliveries([row as QueuedMessage], { error: jest.fn() }, 't');

    expect(row?.proto).toBe(proto);
  });

  it('leaves a DM one inline row per device, exactly as before', async () => {
    await send(DM_GROUP);

    expect(await count('queued_payload')).toBe(0);
    expect(await count('queued_message', `proto IS NOT NULL AND "payloadId" IS NULL`)).toBe(5);
  });

  it('hands every device the row it always got, and an ACK takes only that device record', async () => {
    await send(KEY_GROUP);
    const [frame] = await pull(SEATS[0]);
    const proto = (await ds.query(`SELECT proto FROM queued_payload`))[0].proto as string;

    expect(frame.proto).toBe(proto);
    expect('payloadId' in frame).toBe(false);

    // Another device cannot ACK it: the record is scoped to its own device.
    expect(
      (
        await service.acknowledgeMessages(
          { userId: SEATS[1].userId, deviceId: SEATS[1].deviceId, messageIds: [frame.id] },
          SEATS[1].userId,
          undefined
        )
      ).count
    ).toBe(0);
    expect(
      (
        await service.acknowledgeMessages(
          { userId: SEATS[0].userId, deviceId: SEATS[0].deviceId, messageIds: [frame.id] },
          SEATS[0].userId,
          undefined
        )
      ).count
    ).toBe(1);

    await (
      app as unknown as { cleanupExpiredQueuedMessages(): Promise<void> }
    ).cleanupExpiredQueuedMessages();
    expect(await count('queued_payload')).toBe(1);
    expect(await pull(SEATS[0])).toEqual([]);
    for (const seat of SEATS.slice(1)) {
      const rows = await pull(seat);
      expect(rows.map((r) => r.proto)).toEqual([proto]);
    }
  });

  it('collects the payload once the LAST device has acknowledged it, and not before', async () => {
    await send(KEY_GROUP);
    const collect = () =>
      (
        app as unknown as { cleanupExpiredQueuedMessages(): Promise<void> }
      ).cleanupExpiredQueuedMessages();

    for (const [i, seat] of SEATS.entries()) {
      const [frame] = await pull(seat);
      await service.acknowledgeMessages(
        { userId: seat.userId, deviceId: seat.deviceId, messageIds: [frame.id] },
        seat.userId,
        undefined
      );
      await collect();
      expect(await count('queued_payload')).toBe(i === SEATS.length - 1 ? 0 : 1);
    }
  });

  it('shares a payload among an ADDRESSED subset, and keeps a single addressee inline', async () => {
    await send(KEY_GROUP, { recipientDevices: ['u-1:web-1a', 'u-2:web-2'] });

    expect(await count('queued_payload')).toBe(1);
    expect(await count('queued_message', `"payloadId" IS NOT NULL`)).toBe(2);
    expect((await pull(SEATS[3])).length).toBe(0);
    expect((await pull(SEATS[2])).length).toBe(1);

    await send(KEY_GROUP, { recipientDevices: ['u-3:web-3'] });
    expect(await count('queued_payload')).toBe(1);
    expect(await count('queued_message', `"payloadId" IS NULL AND proto IS NOT NULL`)).toBe(1);
  });

  it('purging one device takes its record and leaves the others their payload', async () => {
    await send(KEY_GROUP);

    const purged = await service.purgeDeviceFootprint(SEATS[2].userId, SEATS[2].deviceId);
    await (
      app as unknown as { cleanupExpiredQueuedMessages(): Promise<void> }
    ).cleanupExpiredQueuedMessages();

    expect(purged.queuedMessagesDeleted).toBe(1);
    expect(await count('queued_payload')).toBe(1);
    expect((await pull(SEATS[0])).length).toBe(1);
  });

  it('retention expires the records by age and then the payload nothing references - and only that one', async () => {
    await send(KEY_GROUP);
    await send(KEY_GROUP);
    const [oldPayload] = await ds.query(
      `SELECT id FROM queued_payload ORDER BY "createdAt" LIMIT 1`
    );
    const past = new Date(Date.now() - RETENTION_WINDOW_MS - 60_000);
    await ds.query(`UPDATE queued_message SET "createdAt" = $1 WHERE "payloadId" = $2`, [
      past,
      oldPayload.id,
    ]);

    await (
      app as unknown as { cleanupExpiredQueuedMessages(): Promise<void> }
    ).cleanupExpiredQueuedMessages();

    expect(await count('queued_payload')).toBe(1);
    expect(await count('queued_payload', `id = '${oldPayload.id}'`)).toBe(0);
    expect(await count('queued_message')).toBe(5);
  });

  it('serves a pre-034 inline row on a key group unchanged, beside the shared ones', async () => {
    await repo(QueuedMessage).save({
      ...SEATS[0],
      recipientId: SEATS[0].userId,
      groupId: KEY_GROUP,
      proto: 'T0xE',
      senderId: SENDER.userId,
      senderDeviceId: SENDER.deviceId,
    });
    await send(KEY_GROUP);

    const rows = await pull(SEATS[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0].proto).toBe('T0xE');
    expect(rows.every((r) => !('payloadId' in r))).toBe(true);
  });

  it('a group that ends takes its payloads with its records, in one transaction', async () => {
    await send(KEY_GROUP);
    await send(DM_GROUP);

    const counts = await tombstoneGroups(ds.manager, redis as never, [KEY_GROUP]);

    expect(counts.queuedMessages).toBe(5);
    expect(counts.queuedPayloads).toBe(1);
    expect(await count('queued_payload')).toBe(0);
  });

  it('the hourly depth report sizes a shared record by its payload (the SQL parses and joins)', async () => {
    // About 200 kB of base64, so the report's one-decimal MB figure can tell it from nothing.
    await send(KEY_GROUP, {
      proto: mlsFrame(
        2,
        'big',
        0n,
        1,
        Array.from({ length: 150_000 }, () => 1)
      ),
    });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await (app as unknown as { reportQueueDepth(): Promise<void> }).reportQueueDepth();

    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('heaviest'));
    // Every seat's record weighs the payload's bytes, never the NULL it stores.
    expect(line).toContain('web-1a=1/0.2MB');
    expect(line).not.toContain('/0.0MB');
  });
});
