import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { NotificationType } from './notification-client-floor';

const logger = new Logger('NotificationCategory');

/**
 * THE READER'S NOTIFICATION SWITCHES, AS SOCIAL-SERVICE READS THEM - chat-delivery's
 * `notification_preference` (migrations 028 and 047 there), the same database on every estate.
 *
 * chat-delivery decides the PUSH (`services/push-category.ts`); this file decides what social-service
 * WRITES and SERVES under the same switches (docs/wiki/engagement.md, "Aligned with the charter"):
 * - TWO READINGS. In the app, a category is off when `"disabledCategories"` lists it - for
 *   "Suggestions" that is "Suggestions dans l'app", ON by default (owner, "Deux niveaux",
 *   2026-11-11: the carousel, "Suivez aussi...", the suggested posts of Pour toi, the trend rows of
 *   the bell). Its PUSH is opt-in ({@link OPT_IN_CATEGORIES}): pushed only when also listed in
 *   `"enabledCategories"`. Principle 3: each suggestion is switched off in one gesture.
 * - THE BELL is gated for suggestion and engagement content ONLY ({@link BELL_ROW_GATE}); a notice
 *   that asks the reader to act, or answers their own request, is always written.
 *
 * A spec reads chat-delivery's file to pin the opt-in list and the category ids to it: no compiler
 * spans a service boundary.
 */

/** chat-delivery's `OPT_IN_CATEGORIES`: never PUSHED until the account turns the push on. */
export const OPT_IN_CATEGORIES = ['suggestions'] as const;

/** The category of every suggestion: in the app on by default, its push opt-in. */
export const SUGGESTIONS_CATEGORY = 'suggestions';

const OPT_IN_SQL = OPT_IN_CATEGORIES.map((c) => `'${c}'`).join(', ');

/**
 * A SQL boolean: category `category` (a SQL text expression - a parameter or a quoted literal) is
 * switched OFF IN THE APP for the account `user` - its row lists it in `"disabledCategories"`. An
 * account with no row has every category on. What the bell's writes and the suggestion surfaces ask.
 */
export function inAppCategoryOffSql(user: string, category: string): string {
  return `EXISTS (SELECT 1 FROM notification_preference nc_p
                   WHERE nc_p."userId" = ${user} AND nc_p."disabledCategories" ? ${category})`;
}

/**
 * A SQL boolean: category `category` is NOT PUSHED to the account `user` - off in the app, or an
 * opt-in category whose push the row does not list in `"enabledCategories"` (so an account with no
 * row is pushed no opt-in category). chat-delivery's `effectiveDisabledCategories`, in SQL: what the
 * daily push cap asks before it counts a push.
 */
export function pushCategoryOffSql(user: string, category: string): string {
  return `(${inAppCategoryOffSql(user, category)}
     OR (${category} IN (${OPT_IN_SQL})
         AND NOT EXISTS (SELECT 1 FROM notification_preference nc_e
                          WHERE nc_e."userId" = ${user} AND nc_e."enabledCategories" ? ${category})))`;
}

/** A SQL boolean: the account `user` has "Suggestions dans l'app" on (the default). */
export function suggestionsOnSql(user: string): string {
  return `NOT ${inAppCategoryOffSql(user, `'${SUGGESTIONS_CATEGORY}'`)}`;
}

/**
 * Whether `userId` has "Suggestions dans l'app" on. A read that fails answers NO, said at WARN: a
 * page without suggestions is still a whole page, and showing one the reader switched off is what
 * the switch exists to prevent.
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
 * THE CATEGORY EACH BELL TYPE'S PUSH FILES UNDER, the one chat-delivery applies (through the type's
 * content keys), or `null` for a type no switch governs: moderation of the reader's own account, the
 * answer to the reader's own request, a correction of their profile, an admin report. Pinned to
 * chat-delivery's filing by the spec. The BELL reads {@link BELL_ROW_GATE}, not this.
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
 * WHICH BELL ROWS A SWITCH MAY WITHHOLD - ONE ALLOWLIST (review of #3329, P2). A category switched
 * off stops its PUSH (chat-delivery); in the BELL it withholds ONLY suggestion and engagement
 * content - what the app volunteers to bring the reader back: a trend, a followed person's
 * activity, a birthday. NEVER a notice that asks the reader to act (a payment over capacity, paused
 * payments, a delegation not ready, a repost or an event awaiting their answer), the answer to their
 * own request (an event validated or rejected, a repost accepted or refused), one addressed to them
 * (a comment, a reaction, a mention), nor what they subscribed to. `null` = always written. A
 * `Record` over every type: a new type does not compile until it is classified, and the spec pins
 * the gated list.
 */
export const BELL_ROW_GATE: Readonly<Record<NotificationType, string | null>> = {
  // Suggestion and engagement content: withheld while its category is off in the app.
  campus_trend: SUGGESTIONS_CATEGORY,
  friend_reaction: 'posts',
  friend_comment: 'posts',
  birthday: 'birthdays',
  // Everything else is always written.
  comment: null,
  reply: null,
  reaction: null,
  mention: null,
  form_reminder: null,
  association_post: null,
  followed_post: null,
  association_repost: null,
  repost_proposed: null,
  coorganise_proposed: null,
  event_proposed: null,
  event_validated: null,
  event_rejected: null,
  event_updated: null,
  event_deleted: null,
  event_pending: null,
  event_pending_coorganiser: null,
  event_open: null,
  profile_correction_applied: null,
  profile_correction_refused: null,
  repost_personal_requested: null,
  repost_personal_accepted: null,
  repost_personal_refused: null,
  live_cut: null,
  live_suspended: null,
  live_withdrawn: null,
  form_paid_over_capacity: null,
  lydia_payments_active: null,
  lydia_payments_paused: null,
  lydia_refund_issued: null,
  lydia_cashier_added: null,
  delegation_revoked: null,
  delegation_receiver_not_ready: null,
  delegation_resumed: null,
  follow_request: null,
  follow_accepted: null,
  booking_cancelled: null,
  booking_withdrawn: null,
  booking_added: null,
  booking_reminder: null,
  booking_changed: null,
  booking_removed: null,
  booking_open: null,
  member_repost: null,
};

/**
 * `recipients` minus every reader who switched off, in the app, the category that gates `type`'s bell
 * row ({@link BELL_ROW_GATE}). One statement; an always-written type answers every recipient
 * untouched. THROWS on a failed read: the caller's write then fails as a failed insert would, and its
 * own log names the notice - writing every row anyway would put back what the reader turned off.
 */
export async function recipientsWithCategoryOn(
  manager: Pick<EntityManager, 'query'>,
  type: NotificationType,
  recipients: readonly string[]
): Promise<string[]> {
  const category = BELL_ROW_GATE[type];
  if (!category || recipients.length === 0) return [...recipients];
  const rows: { r: string }[] = await manager.query(
    `SELECT r FROM unnest($1::varchar[]) r WHERE NOT ${inAppCategoryOffSql('r', '$2::text')}`,
    [recipients, category]
  );
  const on = new Set(rows.map((row) => row.r));
  const kept = recipients.filter((id) => on.has(id));
  if (kept.length < recipients.length) {
    logger.debug(
      `[NOTIFY] type=${type}: no bell row for ${recipients.length - kept.length} of ${recipients.length} (category ${category} off)`
    );
  }
  return kept;
}
