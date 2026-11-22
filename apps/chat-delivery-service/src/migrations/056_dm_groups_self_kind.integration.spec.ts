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
import { GroupsController } from '../controllers/groups.controller';
import type { MessagingService } from '../services/messaging.service';

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
      entities: [Group],
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
    await ds.query(
      `INSERT INTO dm_groups (id, name, "isGroup", "createdBy") VALUES ($1, 'Promo', true, $2)`,
      [LEGACY_GROUP, OWNER]
    );
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
    other = dataSource();
    await other.initialize();
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
    expect(refusals[0]).toMatchObject({
      status: 409,
      code: 'SELF_CONVERSATION_EXISTS',
      groupId: live.id,
    });
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
