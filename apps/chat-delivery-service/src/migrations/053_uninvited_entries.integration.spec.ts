/// <reference types="jest" />

/**
 * MIGRATION 053 AND THE UNINVITED-ENTRY COUNT, AGAINST A REAL POSTGRESQL: the table lands and replays
 * as a no-op, the entity reads what the migration wrote, the first claim of an entry under a kind is
 * the only one that answers `true` - across two connections, which is what a second replica or the
 * process after a deploy is - and the sweep deletes by age only.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. Works in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 053_uninvited_entries
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { UninvitedEntry } from '../entities/uninvited-entry.entity';
import {
  claimUninvitedEntry,
  deleteUninvitedEntriesBefore,
  type UninvitedEntryRow,
} from '../utils/uninvited-entries';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '053_uninvited_entries.sql'), 'utf8');

const GROUP = '55555555-5555-4555-8555-555555555555';

maybe('migration 053 (uninvited_entries) against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `uninvited_entries_it_${Date.now()}`;
  const options = { extra: { options: `-c search_path=${schema}` } };
  let admin: Client;
  let ds: DataSource;
  /** A second connection pool on the same schema: another replica, or the service after a deploy. */
  let other: DataSource;

  const entry = (over: Partial<UninvitedEntryRow> = {}): UninvitedEntryRow => ({
    groupId: GROUP,
    entrant: 'c3c3c3c3:dev1',
    epoch: '7',
    kind: 'new-person',
    watchedFrom: '4',
    ...over,
  });
  const dataSource = () =>
    new DataSource({
      type: 'postgres',
      url: URL,
      entities: [UninvitedEntry],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      ...options,
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = dataSource();
    await ds.initialize();
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
    other = dataSource();
    await other.initialize();
  });

  afterAll(async () => {
    await other?.destroy();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('is read by the entity as written by the migration', async () => {
    await expect(ds.getRepository(UninvitedEntry).count()).resolves.toBe(0);
  });

  it('counts an entry once, whichever connection reports it again', async () => {
    await expect(claimUninvitedEntry(ds, entry())).resolves.toBe(true);

    await expect(claimUninvitedEntry(ds, entry({ watchedFrom: 'none' }))).resolves.toBe(false);
    await expect(claimUninvitedEntry(other, entry())).resolves.toBe(false);

    // The first reporter's evidence is what the row keeps.
    const row = await ds.getRepository(UninvitedEntry).findOneByOrFail({ epoch: '7' });
    expect(row.watchedFrom).toBe('4');
  });

  it('counts the same entry again under another kind, and a later entry of the same device apart', async () => {
    await expect(claimUninvitedEntry(ds, entry({ epoch: '9' }))).resolves.toBe(true);
    await expect(claimUninvitedEntry(ds, entry({ epoch: '9', kind: 'returning' }))).resolves.toBe(
      true
    );
    await expect(claimUninvitedEntry(ds, entry({ epoch: '10' }))).resolves.toBe(true);
  });

  it('two concurrent claims of one entry: exactly one counts it', async () => {
    const both = await Promise.all([
      claimUninvitedEntry(ds, entry({ epoch: '20' })),
      claimUninvitedEntry(other, entry({ epoch: '20' })),
    ]);

    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it('the sweep deletes by age only, and answers how many went', async () => {
    await ds.query(
      `UPDATE uninvited_entries SET "firstSeenAt" = '2026-01-01T00:00:00Z' WHERE epoch = '7'`
    );

    await expect(deleteUninvitedEntriesBefore(ds, new Date('2026-06-01T00:00:00Z'))).resolves.toBe(
      1
    );

    const left = await ds.getRepository(UninvitedEntry).find();
    expect(left.map((r) => r.epoch).sort()).toEqual(['10', '20', '9', '9']);
  });
});
