/// <reference types="jest" />

/**
 * A SAVE FROM AN OLDER BUILD KEEPS THE CHOICES IT CANNOT NAME, AGAINST A REAL POSTGRESQL.
 *
 * Review of #3312 (D1): "Suggestions" joined the closed set of categories in `1.6.10`. A `1.6.9`
 * phone draws no switch for it, so when it saved its own switches it replaced the stored set with
 * one that did not list `suggestions` - switching back on, from another device, what the reader had
 * switched off. `writeDisabledCategories` now merges in ONE statement: the caller's set, plus the
 * stored choice for every category the caller cannot name. Here: the table as migration 028 ships
 * it, the merge both ways, and two overlapping saves that each keep the other's unnamed choice.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, like every chat-delivery integration spec.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { NotificationPreference } from '../entities/notification-preference.entity';
import {
  readDisabledCategoriesStrict,
  readSwitchesStrict,
  writeDisabledCategories,
} from './notification-preferences';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('the disabled categories merge (PostgreSQL)', () => {
  jest.setTimeout(60_000);
  const schema = `notif_pref_it_${Date.now()}`;
  let admin: Client;
  let ds: DataSource;

  /** The categories NOT pushed to `userId` (the push path's reading). */
  const pushOff = async (userId: string) =>
    [...(await readDisabledCategoriesStrict(ds.manager, userId))].sort();

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    for (const file of ['028_notification_preferences.sql', '047_notification_opt_in.sql']) {
      await admin.query(readFileSync(resolve(__dirname, '../migrations', file), 'utf8'));
    }
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [NotificationPreference],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    await ds?.destroy();
  });

  it('a first save stores the set, and answers it', async () => {
    expect(await writeDisabledCategories(ds.manager, 'u1', ['posts', 'forms'], [], [])).toEqual({
      disabled: ['posts', 'forms'],
      enabled: [],
    });
    expect(await pushOff('u1')).toEqual(['forms', 'posts', 'suggestions']);
  });

  it('an account with no row: Suggestions in the app ON, its push OFF ("Deux niveaux", owner 2026-11-11)', async () => {
    expect(await readSwitchesStrict(ds.manager, 'nobody')).toEqual({ disabled: [], enabled: [] });
    expect(await pushOff('nobody')).toEqual(['suggestions']);
  });

  it('the push is sent only when turned on AND the category is not off in the app', async () => {
    await writeDisabledCategories(ds.manager, 'u0', [], [], ['suggestions']);
    expect(await pushOff('u0')).toEqual([]);
    // "Suggestions dans l'app" off: one gesture, and no push either.
    await writeDisabledCategories(ds.manager, 'u0', ['suggestions'], [], ['suggestions']);
    expect(await pushOff('u0')).toEqual(['suggestions']);
  });

  it('a save that does not declare the opt-in reading never touches the push (P3: an alpha.1 save)', async () => {
    await writeDisabledCategories(ds.manager, 'u6', [], []);
    expect((await readSwitchesStrict(ds.manager, 'u6')).enabled).toEqual([]);
    // Turned on by a build that declares it, then an undeclared save keeps it on.
    await writeDisabledCategories(ds.manager, 'u6', [], [], ['suggestions']);
    await writeDisabledCategories(ds.manager, 'u6', ['forms'], []);
    expect(await readSwitchesStrict(ds.manager, 'u6')).toEqual({
      disabled: ['forms'],
      enabled: ['suggestions'],
    });
    // And off again from a build that draws it.
    await writeDisabledCategories(ds.manager, 'u6', [], [], []);
    expect((await readSwitchesStrict(ds.manager, 'u6')).enabled).toEqual([]);
  });

  it("a build that cannot name suggestions keeps the reader's choice of it, and replaces the rest", async () => {
    await writeDisabledCategories(ds.manager, 'u2', ['posts', 'suggestions'], [], []);
    // A 1.6.9 save: switches Publications back on, says nothing of Suggestions.
    await writeDisabledCategories(ds.manager, 'u2', ['forms'], ['suggestions']);
    expect((await readSwitchesStrict(ds.manager, 'u2')).disabled).toEqual(['forms', 'suggestions']);
  });

  it('a kept category keeps its stored state, its push included', async () => {
    await writeDisabledCategories(ds.manager, 'u4', ['posts'], [], ['suggestions']);
    await writeDisabledCategories(ds.manager, 'u4', ['posts'], ['suggestions', 'birthdays'], []);
    expect(await readSwitchesStrict(ds.manager, 'u4')).toEqual({
      disabled: ['posts'],
      enabled: ['suggestions'],
    });
  });

  it('two overlapping saves each merge against the row the other committed', async () => {
    await writeDisabledCategories(ds.manager, 'u5', ['suggestions'], [], []);
    // A second session holds the row; both saves queue behind it, then run one after the other.
    const holder = new Client({ connectionString: URL });
    await holder.connect();
    await holder.query(`SET search_path TO ${schema}`);
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM notification_preference WHERE "userId" = 'u5' FOR UPDATE`);
    const saves = Promise.all([
      writeDisabledCategories(ds.manager, 'u5', ['posts'], ['suggestions']),
      writeDisabledCategories(ds.manager, 'u5', ['forms'], ['suggestions']),
    ]);
    await holder.query('COMMIT');
    await holder.end();
    await saves;
    // Whichever committed last, the choice neither caller could name survives both.
    expect((await readSwitchesStrict(ds.manager, 'u5')).disabled).toContain('suggestions');
    // The same for a push turned ON: neither 1.6.9 save may switch it back off.
    await writeDisabledCategories(ds.manager, 'u7', [], [], ['suggestions']);
    await Promise.all([
      writeDisabledCategories(ds.manager, 'u7', ['posts'], ['suggestions'], []),
      writeDisabledCategories(ds.manager, 'u7', ['forms'], ['suggestions'], []),
    ]);
    expect((await readSwitchesStrict(ds.manager, 'u7')).enabled).toEqual(['suggestions']);
  });
});
