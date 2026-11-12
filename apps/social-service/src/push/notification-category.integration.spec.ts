/// <reference types="jest" />

/**
 * THE READER'S SWITCHES, READ BY SOCIAL-SERVICE, AGAINST A REAL POSTGRESQL - chat-delivery's
 * `notification_preference` as its migrations 028 and 047 build it. "Deux niveaux" (owner,
 * 2026-11-11): "Suggestions dans l'app" is on until switched off; the PUSH of Suggestions is off
 * until turned on, and never sent while the app switch is off; every other category is on until
 * disabled; the bell withholds only suggestion and engagement content.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every social-service integration spec.
 */
import { Client } from 'pg';
import {
  inAppCategoryOffSql,
  pushCategoryOffSql,
  recipientsWithCategoryOn,
  suggestionsOn,
} from './notification-category';
import {
  createNotificationPreferenceTable,
  turnSuggestionPushOn,
} from '../posts/post-notifications.it-schema';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('notification categories (PostgreSQL)', () => {
  jest.setTimeout(60_000);
  const schema = `notif_category_it_${Date.now()}`;
  let admin: Client;
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const manager = { query: async (sql: string, params?: unknown[]) => (await q(sql, params)).rows };

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    await createNotificationPreferenceTable((sql) => q(sql));
    // A re-run of the two files is a no-op (the deploy ledger may run them twice).
    await createNotificationPreferenceTable((sql) => q(sql));
    // quiet: the alpha.1 switch off (and birthdays); touched: a row that says nothing; asked: the
    // push turned on; mutedAsked: the push turned on, then the app switch off.
    await q(`INSERT INTO notification_preference ("userId", "disabledCategories") VALUES
      ('quiet', '["birthdays", "suggestions"]'), ('touched', '[]')`);
    await turnSuggestionPushOn(q, ['asked', 'mutedAsked']);
    await q(
      `UPDATE notification_preference SET "disabledCategories" = '["suggestions"]' WHERE "userId" = 'mutedAsked'`
    );
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const inAppOff = async (user: string, category: string) =>
    (await q(`SELECT ${inAppCategoryOffSql('$1::varchar', '$2::text')} AS off`, [user, category]))
      .rows[0].off as boolean;
  const pushOff = async (user: string, category: string) =>
    (await q(`SELECT ${pushCategoryOffSql('$1::varchar', '$2::text')} AS off`, [user, category]))
      .rows[0].off as boolean;

  it('Suggestions in the app: on with no row, off only for the reader who switched it off', async () => {
    expect(await suggestionsOn(manager, 'nobody')).toBe(true);
    expect(await suggestionsOn(manager, 'touched')).toBe(true);
    expect(await suggestionsOn(manager, 'quiet')).toBe(false);
    expect(await inAppOff('asked', 'suggestions')).toBe(false);
  });

  it('the push of Suggestions: off until turned on, and never while the app switch is off', async () => {
    expect(await pushOff('nobody', 'suggestions')).toBe(true);
    expect(await pushOff('touched', 'suggestions')).toBe(true);
    expect(await pushOff('quiet', 'suggestions')).toBe(true);
    expect(await pushOff('asked', 'suggestions')).toBe(false);
    expect(await pushOff('mutedAsked', 'suggestions')).toBe(true);
  });

  it('every other category is on until disabled, in the app and in the push', async () => {
    expect(await pushOff('nobody', 'birthdays')).toBe(false);
    expect(await pushOff('quiet', 'birthdays')).toBe(true);
    expect(await inAppOff('quiet', 'posts')).toBe(false);
  });

  it('the bell withholds a gated type only for a reader who switched its category off in the app', async () => {
    expect(
      await recipientsWithCategoryOn(manager, 'birthday', ['nobody', 'quiet', 'touched'])
    ).toEqual(['nobody', 'touched']);
    // A trend row reaches every reader with the app switch on - its push being opt-in changes nothing here.
    expect(
      await recipientsWithCategoryOn(manager, 'campus_trend', ['nobody', 'quiet', 'asked'])
    ).toEqual(['nobody', 'asked']);
    // An always-written type reaches every recipient, with no read.
    expect(await recipientsWithCategoryOn(manager, 'live_cut', ['quiet'])).toEqual(['quiet']);
  });
});
