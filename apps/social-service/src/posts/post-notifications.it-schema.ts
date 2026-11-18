import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The migrations that add a column to `post_notifications` and need nothing else. Each takes ITS type
 * from the file every estate ran, never from a spec's guess: a hand-written `"associationId"
 * varchar` let #3019 ship a `uuid ~* text` comparison that answered 500 on dev's real `uuid`
 * column while its spec stayed green.
 */
const POST_NOTIFICATIONS_MIGRATIONS = [
  '061_post_notifications_association_identity.sql',
  '117_post_notifications_meta.sql',
] as const;

/**
 * Builds `post_notifications` in the current `search_path` as the estates hold it: the columns no
 * migration adds (TypeORM created them before migrations existed - `\d post_notifications` on dev,
 * 2026-11-04), then the column migrations above, read from `src/migrations`.
 *
 * The two other migrations on the table are the CALLER's to apply in its own migration loop: 126
 * (the bell's index) and 132 (`commentId`), which alters `read_grant_journal` and so must run after
 * 078. A spec that reads the bell through its entity needs 132.
 */
export async function createPostNotificationsTable(
  q: (sql: string) => Promise<unknown>
): Promise<void> {
  await q(`
    CREATE TABLE post_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "recipientId" varchar NOT NULL, type varchar NOT NULL, "postId" varchar NOT NULL,
      "actorId" varchar NOT NULL, "actorName" varchar, text varchar NOT NULL,
      read boolean NOT NULL DEFAULT false, "createdAt" timestamp NOT NULL DEFAULT now());
  `);
  for (const file of POST_NOTIFICATIONS_MIGRATIONS) {
    await q(readFileSync(join(__dirname, '..', 'migrations', file), 'utf8'));
  }
  // A gated bell row (`BELL_ROW_GATE`) is written only for a reader whose category is on.
  await createNotificationPreferenceTable(q);
}

/**
 * Makes sure what the bell's TARGET gates read exists (`bell-row-gates.ts`, `targetBoundRowShownSql`):
 * the bell's one statement names the events, their co-organisers, the booking spaces and the forms
 * whatever kinds a reader holds, so a spec that reads the bell needs them even when it writes none.
 * Run AFTER the spec's own tables and migrations (071 and 078 among them, which the event predicate
 * reads), over the `users` and `association_members` tables the spec built (and its `post_notifications`,
 * when it has one rather than reading rows from a `VALUES` list): every table is `IF NOT EXISTS` and every column `ADD COLUMN IF NOT EXISTS`, so a spec that
 * built one of them richer keeps it, and the reach columns come from migration 165, the file every
 * estate ran.
 */
export async function createBellTargetTables(q: (sql: string) => Promise<unknown>): Promise<void> {
  await q(`
    ALTER TABLE IF EXISTS post_notifications ADD COLUMN IF NOT EXISTS meta jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS admin boolean NOT NULL DEFAULT false;
    ALTER TABLE association_members ADD COLUMN IF NOT EXISTS permissions int NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS association_calendar_events (id uuid PRIMARY KEY);
    ALTER TABLE association_calendar_events
      ADD COLUMN IF NOT EXISTS id uuid,
      ADD COLUMN IF NOT EXISTS "associationId" uuid,
      ADD COLUMN IF NOT EXISTS title varchar(200),
      ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'validated';
    CREATE TABLE IF NOT EXISTS association_calendar_event_co_owners (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL, association_id uuid NOT NULL);
    -- The estates' key (migration 074): the bell's party gate probes it per row.
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_calendar_event_co_owner"
      ON association_calendar_event_co_owners (event_id, association_id);
    CREATE TABLE IF NOT EXISTS booking_spaces (id uuid PRIMARY KEY);
    ALTER TABLE booking_spaces
      ADD COLUMN IF NOT EXISTS "associationId" uuid,
      ADD COLUMN IF NOT EXISTS "ownerId" varchar,
      ADD COLUMN IF NOT EXISTS name varchar,
      ADD COLUMN IF NOT EXISTS discoverability varchar NOT NULL DEFAULT 'listed',
      ADD COLUMN IF NOT EXISTS audience jsonb;
    CREATE TABLE IF NOT EXISTS forms (id uuid PRIMARY KEY);
    ALTER TABLE forms
      ADD COLUMN IF NOT EXISTS "ownerId" varchar(255),
      ADD COLUMN IF NOT EXISTS "associationId" uuid,
      ADD COLUMN IF NOT EXISTS title varchar;
    -- The two admin queue notices' gates (admin-queue-sql.ts); the estates' reports table was
    -- created by TypeORM, these are the columns the gates read.
    CREATE TABLE IF NOT EXISTS content_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    ALTER TABLE content_reports
      ADD COLUMN IF NOT EXISTS "contentType" varchar(30) NOT NULL DEFAULT 'post',
      ADD COLUMN IF NOT EXISTS "contentId" varchar NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now();
  `);
  // core-service's queue, from the file every estate ran (its `profile_changes` line needs the table).
  await q(
    `CREATE TABLE IF NOT EXISTS profile_changes (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`
  );
  await q(
    readFileSync(
      join(__dirname, '../../../core-service/src/migrations/010_profile_correction_requests.sql'),
      'utf8'
    )
  );
  await q(
    readFileSync(join(__dirname, '..', 'migrations', '165_institution_event_reach.sql'), 'utf8')
  );
}

/**
 * Builds chat-delivery's `notification_preference` from the files the estates ran - its migration
 * 028 and 047 (the opt-in categories, "Suggestions" off until turned on), the same database on every
 * estate. Idempotent, so a spec may build it through more than one helper.
 */
export async function createNotificationPreferenceTable(
  q: (sql: string) => Promise<unknown>
): Promise<void> {
  for (const file of ['028_notification_preferences.sql', '047_notification_opt_in.sql']) {
    await q(
      readFileSync(join(__dirname, '../../../chat-delivery-service/src/migrations', file), 'utf8')
    );
  }
}

/**
 * Turns the PUSH of "Suggestions" on for each of `userIds` - opt-in since 2026-11-10 - as a
 * `1.6.10` save of that switch writes it.
 */
export async function turnSuggestionPushOn(
  q: (sql: string, params?: unknown[]) => Promise<unknown>,
  userIds: readonly string[]
): Promise<void> {
  for (const id of userIds) {
    await q(
      `INSERT INTO notification_preference ("userId", "enabledCategories") VALUES ($1, '["suggestions"]')
       ON CONFLICT ("userId") DO UPDATE SET "enabledCategories" = '["suggestions"]'`,
      [id]
    );
  }
}

/**
 * Switches "Suggestions dans l'app" OFF for each of `userIds` (on by default, owner's "Deux niveaux"
 * of 2026-11-11) - the alpha.1 switch's "off" row, which also silences the push.
 */
export async function turnSuggestionsOffInApp(
  q: (sql: string, params?: unknown[]) => Promise<unknown>,
  userIds: readonly string[]
): Promise<void> {
  for (const id of userIds) {
    await q(
      `INSERT INTO notification_preference ("userId", "disabledCategories") VALUES ($1, '["suggestions"]')
       ON CONFLICT ("userId") DO UPDATE SET "disabledCategories" = '["suggestions"]'`,
      [id]
    );
  }
}

/**
 * Builds what the DAILY PUSH CAP reads (engagement WP-8): `engagement_push_days` (migration 157),
 * the weekly trend counters its GC also prunes (migration 163), chat-delivery's
 * `notification_preference` (its migrations 028 and 047, the same database on every estate) - all read from
 * the files the estates ran - and the two chat-delivery tables the claim's device floor reads,
 * `push_token` and `key_package`, which no migration creates (TypeORM did): only the columns the
 * claim reads, typed as the entities type them. Every spec that sends a COUNTED type through the
 * real notification service needs them since the cap widened (owner, 2026-11-10): without them the
 * claim fails, and a failed claim pushes nobody. A reader needs a device ({@link givePushDevices})
 * to be pushed a type with a floor.
 */
export async function createEngagementPushCapTables(
  q: (sql: string) => Promise<unknown>
): Promise<void> {
  for (const file of ['157_engagement_push_days.sql', '163_campus_trend_weeks.sql']) {
    await q(readFileSync(join(__dirname, '..', 'migrations', file), 'utf8'));
  }
  await createNotificationPreferenceTable(q);
  await q(`
    CREATE TABLE IF NOT EXISTS push_token (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL);
    CREATE TABLE IF NOT EXISTS key_package (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
      "deviceAppVersion" varchar(32), UNIQUE ("userId", "deviceId"));
  `);
}

/**
 * Gives each of `userIds` one push device: a token, and a key package reporting `version` (NULL: a
 * build never reported, which the floor keeps, as chat-delivery does).
 */
export async function givePushDevices(
  q: (sql: string, params?: unknown[]) => Promise<unknown>,
  userIds: readonly string[],
  version: string | null = null
): Promise<void> {
  for (const userId of userIds) {
    await q(`INSERT INTO push_token ("userId", "deviceId") VALUES ($1, 'd1')`, [userId]);
    await q(
      `INSERT INTO key_package ("userId", "deviceId", "deviceAppVersion") VALUES ($1, 'd1', $2)`,
      [userId, version]
    );
  }
}
