/// <reference types="jest" />

/**
 * THE READER'S SWITCHES, READ BY SOCIAL-SERVICE, AGAINST A REAL POSTGRESQL ("Nos principes", owner
 * 2026-11-10): chat-delivery's `notification_preference` as its migrations 028 and 047 build it.
 * "Suggestions" is off with no row and with a row that does not enable it; every other category is
 * on until disabled; a bell row is written only for a reader whose category is on.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every social-service integration spec.
 */
import { Client } from 'pg';
import { categoryOffSql, recipientsWithCategoryOn, suggestionsOn } from './notification-category';
import {
  createNotificationPreferenceTable,
  turnSuggestionsOn,
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
    await q(`INSERT INTO notification_preference ("userId", "disabledCategories") VALUES
      ('quiet', '["birthdays", "suggestions"]'), ('touched', '[]')`);
    await turnSuggestionsOn(q, ['asked']);
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const off = async (user: string, category: string) =>
    (await q(`SELECT ${categoryOffSql('$1::varchar', '$2::text')} AS off`, [user, category]))
      .rows[0].off as boolean;

  it('Suggestions is off with no row, with a row that does not enable it, and on once enabled', async () => {
    expect(await off('nobody', 'suggestions')).toBe(true);
    expect(await off('touched', 'suggestions')).toBe(true);
    // Listed as disabled by a 1.6.10-alpha.1 save: off, and the disabled list is not what decides.
    expect(await off('quiet', 'suggestions')).toBe(true);
    expect(await off('asked', 'suggestions')).toBe(false);
    expect(await suggestionsOn(manager, 'nobody')).toBe(false);
    expect(await suggestionsOn(manager, 'asked')).toBe(true);
  });

  it('every other category is on until disabled', async () => {
    expect(await off('nobody', 'birthdays')).toBe(false);
    expect(await off('quiet', 'birthdays')).toBe(true);
    expect(await off('quiet', 'posts')).toBe(false);
  });

  it('a bell row is written only for a reader whose category is on', async () => {
    expect(
      await recipientsWithCategoryOn(manager, 'birthday', ['nobody', 'quiet', 'touched'])
    ).toEqual(['nobody', 'touched']);
    expect(
      await recipientsWithCategoryOn(manager, 'campus_trend', ['nobody', 'quiet', 'asked'])
    ).toEqual(['asked']);
    // A type no switch governs reaches every recipient, with no read.
    expect(await recipientsWithCategoryOn(manager, 'live_cut', ['quiet'])).toEqual(['quiet']);
  });
});
