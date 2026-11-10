import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { NotificationType } from './notification-client-floor';

const logger = new Logger('NotificationCategory');

/**
 * THE READER'S NOTIFICATION SWITCHES, AS SOCIAL-SERVICE READS THEM - chat-delivery's
 * `notification_preference` (migrations 028 and 047 there), the same database on every estate.
 *
 * chat-delivery decides the PUSH (`services/push-category.ts`); this file decides what social-service
 * WRITES and SERVES under the same switches ("Nos principes", owner 2026-11-10,
 * docs/wiki/engagement.md "Aligned with the charter"):
 * - a category switched off writes NO BELL ROW (`NOTIFICATION_TYPE_CATEGORY`), so nothing the
 *   reader turned off counts in the red badge;
 * - "Suggestions" is OFF until turned on ({@link OPT_IN_CATEGORIES}) and covers every suggestion:
 *   the campus-trend rows, the follow suggestions and the suggested posts of Pour toi.
 *
 * A spec reads chat-delivery's file to pin the opt-in list and the category ids to it: no compiler
 * spans a service boundary.
 */

/** chat-delivery's `OPT_IN_CATEGORIES`: off until the account turns them on (`"enabledCategories"`). */
export const OPT_IN_CATEGORIES = ['suggestions'] as const;

/** The one switch over every suggestion (principle 3: attention is not for sale). */
export const SUGGESTIONS_CATEGORY = 'suggestions';

const OPT_IN_SQL = OPT_IN_CATEGORIES.map((c) => `'${c}'`).join(', ');

/**
 * A SQL boolean: category `category` (a SQL text expression - a parameter or a quoted literal) is
 * OFF for the account `user` (a SQL expression). A default-on category is off when the account's row
 * lists it in `"disabledCategories"`; an opt-in one is off unless its row lists it in
 * `"enabledCategories"` - so an account with no row has exactly the opt-in categories off. THE ONE
 * reading of those two columns in this service: the daily push cap, the bell's writes and every
 * suggestion surface ask it.
 */
export function categoryOffSql(user: string, category: string): string {
  return `(CASE WHEN ${category} IN (${OPT_IN_SQL})
     THEN NOT EXISTS (SELECT 1 FROM notification_preference nc_p
                       WHERE nc_p."userId" = ${user} AND nc_p."enabledCategories" ? ${category})
     ELSE EXISTS (SELECT 1 FROM notification_preference nc_p
                   WHERE nc_p."userId" = ${user} AND nc_p."disabledCategories" ? ${category}) END)`;
}

/** A SQL boolean: the account `user` turned "Suggestions" on. */
export function suggestionsOnSql(user: string): string {
  return `NOT ${categoryOffSql(user, `'${SUGGESTIONS_CATEGORY}'`)}`;
}

/**
 * Whether `userId` turned "Suggestions" on. A read that fails answers NO, said at WARN: a suggestion
 * the reader may not have asked for is the one thing this switch exists to prevent, and a page
 * without suggestions is still a whole page.
 */
export async function suggestionsOn(
  manager: Pick<EntityManager, 'query'>,
  userId: string
): Promise<boolean> {
  try {
    const rows: { enabled: boolean }[] = await manager.query(
      `SELECT ${suggestionsOnSql('$1::varchar')} AS enabled`,
      [userId]
    );
    return rows[0]?.enabled === true;
  } catch (e: unknown) {
    logger.warn(
      `[SUGGESTIONS] switch read failed for ${userId.slice(0, 8)} - no suggestion served: ${String(e)}`
    );
    return false;
  }
}

/**
 * THE CATEGORY EACH BELL TYPE FILES UNDER, the one chat-delivery applies to its push (through the
 * type's content keys), or `null` for a type no switch governs: moderation of the reader's own
 * account, the answer to the reader's own request, a correction of their profile, an admin report.
 * A `Record` over every type, so a new one does not compile until it is placed.
 */
export const NOTIFICATION_TYPE_CATEGORY: Readonly<Record<NotificationType, string | null>> = {
  comment: 'comments',
  reply: 'comments',
  reaction: 'reactions',
  mention: 'mentions',
  form_reminder: 'forms',
  association_post: 'posts',
  followed_post: 'posts',
  association_repost: 'posts',
  repost_proposed: 'posts',
  coorganise_proposed: 'events',
  event_proposed: 'events',
  event_validated: 'events',
  event_rejected: 'events',
  event_updated: 'events',
  event_deleted: 'events',
  event_pending: 'events',
  event_pending_coorganiser: 'events',
  event_open: 'events',
  profile_correction_applied: null,
  profile_correction_refused: null,
  repost_personal_requested: 'posts',
  repost_personal_accepted: null,
  repost_personal_refused: null,
  live_cut: null,
  live_suspended: null,
  live_withdrawn: null,
  form_paid_over_capacity: 'forms',
  lydia_payments_active: 'forms',
  lydia_payments_paused: 'forms',
  lydia_refund_issued: 'forms',
  lydia_cashier_added: null,
  delegation_revoked: 'forms',
  delegation_receiver_not_ready: 'forms',
  delegation_resumed: 'forms',
  follow_request: 'follows',
  follow_accepted: 'follows',
  booking_cancelled: 'bookings',
  booking_withdrawn: 'bookings',
  booking_added: 'bookings',
  booking_reminder: 'bookings',
  booking_changed: 'bookings',
  booking_removed: 'bookings',
  booking_open: 'bookings',
  member_repost: 'posts',
  friend_reaction: 'posts',
  friend_comment: 'posts',
  birthday: 'birthdays',
  campus_trend: SUGGESTIONS_CATEGORY,
};

/**
 * `recipients` minus every reader who switched `type`'s category off - the ones a bell row may be
 * written for. One statement; a type no switch governs answers every recipient untouched. THROWS on
 * a failed read: the caller's write then fails as a failed insert would, and its own log names the
 * notice - writing every row anyway would put back in the badge what the reader turned off.
 */
export async function recipientsWithCategoryOn(
  manager: Pick<EntityManager, 'query'>,
  type: NotificationType,
  recipients: readonly string[]
): Promise<string[]> {
  const category = NOTIFICATION_TYPE_CATEGORY[type];
  if (!category || recipients.length === 0) return [...recipients];
  const rows: { r: string }[] = await manager.query(
    `SELECT r FROM unnest($1::varchar[]) r WHERE NOT ${categoryOffSql('r', '$2::text')}`,
    [recipients, category]
  );
  const on = new Set(rows.map((row) => row.r));
  const kept = recipients.filter((id) => on.has(id));
  if (kept.length < recipients.length) {
    logger.log(
      `[NOTIFY] type=${type}: no bell row for ${recipients.length - kept.length} of ${recipients.length} (category ${category} off)`
    );
  }
  return kept;
}
