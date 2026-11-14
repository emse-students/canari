/// <reference types="jest" />

/**
 * MIGRATION 049 AND "EACH ITEM IS ACCUSED ONCE", AGAINST A REAL POSTGRESQL: the table lands and
 * replays as a no-op; the claim returns an item on its first sighting and on a changed state, never
 * on an unchanged one; two replicas claiming the same item at once accuse it ONCE (the second
 * statement waits on the first's row and finds the state equal); the release deletes and returns
 * exactly the items a report stopped naming, in that report only; the daily summary reads the table.
 * Then the flow end to end: `reportCommitLogHealth` over a real commit log with a hole ERRORs on the
 * first run, is silent on the second, ERRORs again when the hole grows, and logs the group once when
 * it leaves the report.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. The two tables the hole query reads are built in their production column types, in a
 * throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- report-accusations.integration
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppController } from '../app.controller';
import { REPORT_KINDS, settleAccusations, summarizeAccusations } from './report-accusations';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '049_report_accusations.sql'),
  'utf8'
);

/** The columns the hole query reads, as production has them. */
const TABLES = `
  CREATE TABLE dm_groups (
    id uuid PRIMARY KEY, "activeEpoch" integer NOT NULL DEFAULT 0, "deletedAt" timestamp,
    "distributionWorkspaceId" uuid, "distributionChannelId" uuid);
  CREATE TABLE mls_commit_log (
    id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "baseEpoch" integer NOT NULL,
    "senderDeviceId" varchar, "createdAt" timestamp NOT NULL DEFAULT now(),
    UNIQUE ("groupId", "baseEpoch"));`;

maybe('report_accusations (migration 049) against PostgreSQL', () => {
  const schema = `report_accusations_it_${Date.now()}`;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const quiet = { log: jest.fn() };

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      synchronize: false,
      // Two connections at least, so the replica race below really runs on two sessions.
      extra: { options: `-c search_path=${schema}`, max: 4 },
    });
    await ds.initialize();
    await q(TABLES);
    await q(MIGRATION);
  });

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA ${schema} CASCADE`);
    await ds?.destroy();
  });

  beforeEach(async () => {
    await q('DELETE FROM report_accusations');
    jest.restoreAllMocks();
  });

  it('lands the table, and a replay of the migration is a no-op', async () => {
    await q(MIGRATION);
    const columns = (await q(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'report_accusations' ORDER BY column_name`,
      [schema]
    )) as { column_name: string; data_type: string }[];
    expect(columns).toEqual([
      { column_name: 'accusedAt', data_type: 'timestamp with time zone' },
      { column_name: 'itemId', data_type: 'character varying' },
      { column_name: 'report', data_type: 'character varying' },
      { column_name: 'state', data_type: 'text' },
    ]);
  });

  it('accuses on first sighting and on a changed state, never on an unchanged one', async () => {
    const kind = REPORT_KINDS.commitLogHole;
    const first = await settleAccusations(ds, kind, [{ id: 'g1', state: 'a' }], quiet, 'it');
    expect(first.fresh.map((i) => i.id)).toEqual(['g1']);

    const again = await settleAccusations(ds, kind, [{ id: 'g1', state: 'a' }], quiet, 'it');
    expect(again.fresh).toEqual([]);
    expect(again.known.map((i) => i.id)).toEqual(['g1']);

    const changed = await settleAccusations(ds, kind, [{ id: 'g1', state: 'b' }], quiet, 'it');
    expect(changed.fresh.map((i) => i.id)).toEqual(['g1']);
    const [row] = (await q(`SELECT state FROM report_accusations WHERE "itemId" = 'g1'`)) as {
      state: string;
    }[];
    expect(row.state).toBe('b');
  });

  it('accuses an item ONCE when two replicas claim it at the same time', async () => {
    const items = [
      { id: 'g-race', state: 's' },
      { id: 'g-race-2', state: 's' },
    ];
    const [a, b] = await Promise.all([
      settleAccusations(ds, REPORT_KINDS.holders, items, quiet, 'replica-a'),
      settleAccusations(ds, REPORT_KINDS.holders, items, quiet, 'replica-b'),
    ]);
    const accused = [...a.fresh, ...b.fresh].map((i) => i.id).sort();
    expect(accused).toEqual(['g-race', 'g-race-2']);
  });

  it('releases exactly what a report stopped naming, in that report only, and returns it once', async () => {
    await settleAccusations(
      ds,
      REPORT_KINDS.strandedDevice,
      [
        { id: 'web-a', state: 'g1:never' },
        { id: 'web-b', state: 'g2:kicked' },
      ],
      quiet,
      'it'
    );
    await settleAccusations(ds, REPORT_KINDS.staleBase, [{ id: 'web-a', state: 'x' }], quiet, 'it');

    const run = await settleAccusations(
      ds,
      REPORT_KINDS.strandedDevice,
      [{ id: 'web-b', state: 'g2:kicked' }],
      quiet,
      'it'
    );
    expect(run.left.map((l) => [l.itemId, l.state])).toEqual([['web-a', 'g1:never']]);

    const none = await settleAccusations(ds, REPORT_KINDS.strandedDevice, [], quiet, 'it');
    expect(none.left.map((l) => l.itemId)).toEqual(['web-b']);
    const again = await settleAccusations(ds, REPORT_KINDS.strandedDevice, [], quiet, 'it');
    expect(again.left).toEqual([]);

    // Another report's row with the same id is untouched.
    const kept = (await q(`SELECT report FROM report_accusations WHERE "itemId" = 'web-a'`)) as {
      report: string;
    }[];
    expect(kept).toEqual([{ report: REPORT_KINDS.staleBase }]);
  });

  it('summarizes one line per report, zero included, read from the table', async () => {
    await settleAccusations(
      ds,
      REPORT_KINDS.commitLogHole,
      [
        { id: 'g1', state: 'a' },
        { id: 'g2', state: 'a' },
      ],
      quiet,
      'it'
    );
    const logger = { log: jest.fn() };
    const labels = Object.fromEntries(
      Object.values(REPORT_KINDS).map((k) => [k, { prefix: `[${k}]`, items: 'item(s)' }])
    ) as Parameters<typeof summarizeAccusations>[2];

    const out = await summarizeAccusations(ds, logger, labels);

    expect(out.find((s) => s.report === REPORT_KINDS.commitLogHole)?.known).toBe(2);
    expect(logger.log).toHaveBeenCalledTimes(Object.keys(REPORT_KINDS).length);
    const lines = logger.log.mock.calls.map((c) => String(c[0]));
    expect(lines.find((l) => l.startsWith('[commit_log_hole]'))).toContain(
      '2 item(s) already accused, unchanged since'
    );
    expect(lines.find((l) => l.startsWith('[holders]'))).toContain('0 item(s) already accused');
  });

  it('runs the commit-log report end to end: accused once, again when it grows, released once', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    // Only the two members the report reads; the rest of the controller is never reached.
    const controller = new AppController(
      ...(Array.from({ length: 12 }, () => ({})) as ConstructorParameters<typeof AppController>)
    );
    Object.assign(controller as unknown as Record<string, unknown>, {
      groupRepo: { manager: ds.manager },
      commitLogRepo: { query: (sql: string, params?: unknown[]) => ds.query(sql, params) },
    });
    const report = () =>
      (controller as unknown as { reportCommitLogHealth(): Promise<void> }).reportCommitLogHealth();

    // A group at epoch 6 whose log holds 0, 1, 3, 4, 5: epoch 2 was accepted and never recorded.
    const group = randomUUID();
    await q(`INSERT INTO dm_groups (id, "activeEpoch") VALUES ($1, 6)`, [group]);
    for (const epoch of [0, 1, 3, 4, 5]) {
      await q(`INSERT INTO mls_commit_log (id, "groupId", "baseEpoch") VALUES ($1, $2, $3)`, [
        randomUUID(),
        group,
        epoch,
      ]);
    }

    await report();
    await report();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain(`${group}(first hole at 2, 1 missing`);

    // The head moves on with a contiguous commit: the hole is unchanged, nothing is printed.
    await q(`INSERT INTO mls_commit_log (id, "groupId", "baseEpoch") VALUES ($1, $2, 6)`, [
      randomUUID(),
      group,
    ]);
    await q(`UPDATE dm_groups SET "activeEpoch" = 7 WHERE id = $1`, [group]);
    await report();
    expect(error).toHaveBeenCalledTimes(1);

    // The hole grows: epoch 3 is lost too.
    await q(`DELETE FROM mls_commit_log WHERE "groupId" = $1 AND "baseEpoch" = 3`, [group]);
    await report();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[1][0])).toContain(`${group}(first hole at 2, 2 missing`);

    // The group is deleted: it leaves the report and the ledger, logged once.
    await q(`UPDATE dm_groups SET "deletedAt" = now() WHERE id = $1`, [group]);
    await report();
    await report();
    const left = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('no longer reported'));
    expect(left).toHaveLength(1);
    expect(left[0]).toContain(`${group}(first hole 2, 2 missing`);
    expect(await q(`SELECT 1 FROM report_accusations`)).toEqual([]);
  });
});
