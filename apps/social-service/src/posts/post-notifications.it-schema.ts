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
}

/**
 * Builds what the DAILY PUSH CAP reads (engagement WP-8): `engagement_push_days` (migration 157)
 * and chat-delivery's `notification_preference` (its migration 028, the same database on every
 * estate), both read from the files the estates ran. Every spec that sends a COUNTED type through
 * the real notification service needs them since the cap widened (owner, 2026-11-10): without them
 * the claim fails, and a failed claim pushes nobody.
 */
export async function createEngagementPushCapTables(
  q: (sql: string) => Promise<unknown>
): Promise<void> {
  await q(
    readFileSync(join(__dirname, '..', 'migrations', '157_engagement_push_days.sql'), 'utf8')
  );
  await q(
    readFileSync(
      join(
        __dirname,
        '../../../chat-delivery-service/src/migrations/028_notification_preferences.sql'
      ),
      'utf8'
    )
  );
}
