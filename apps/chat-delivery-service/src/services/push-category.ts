/**
 * THE CATEGORIES A USER MAY SWITCH OFF, AND WHICH PUSH BELONGS TO WHICH - the one place either is written.
 *
 * A category is a property of the PUSH, never of a client: the server decides before it sends, so a
 * muted category costs no FCM/APNs message at all and no client has to remember to filter. The
 * frontend mirrors the id list (`frontend/src/lib/notifications/categories.ts`) and a contract test
 * reads this file to pin the two together, because no compiler spans a service boundary.
 *
 * The ids are a CLOSED set and the persisted value is the set of DISABLED ones, so a new category
 * ships ON for every account with no migration - "everything on" is the default by construction.
 */
export const NOTIFICATION_CATEGORIES = [
  /** 1-to-1 and group MLS conversations. */
  'messages',
  /** Messages in community salons (the per-salon level in social-service still applies first). */
  'channels',
  /** An association's publication, or one by someone the reader follows - a post or a live. */
  'posts',
  /** A comment, or a reply to the reader's comment. */
  'comments',
  /** The reader was @-mentioned in a post or a comment. */
  'mentions',
  /** A reaction to the reader's message or post. */
  'reactions',
  /** Calendar events: proposed, validated, rejected, updated, deleted, pending. */
  'events',
  /** Form openings and reminders, and a payment that landed on a full form (to its managers). */
  'forms',
  /** Someone asks to follow the reader, or accepted the reader's request (WP-F4). */
  'follows',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** True when `value` is one of the closed set - the only thing a write may name. */
export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

/** What `contentKey` (social-service `PushContentKey`) files under. */
const CATEGORY_BY_CONTENT_KEY: Readonly<Record<string, NotificationCategory>> = {
  social_mention: 'mentions',
  social_reply: 'comments',
  social_comment: 'comments',
  social_reaction: 'reactions',
  social_association_post: 'posts',
  social_followed_post: 'posts',
  // The republication and co-organisation notices had NO entry, so `categoryOfDataPush` answered null
  // and no switch could ever silence them (2026-10-08 audit): a republished post is a post notice, a
  // repost proposal is a post matter, and a co-organisation proposal is an agenda one.
  social_association_repost: 'posts',
  social_repost_proposed: 'posts',
  // D38b: an association asks an author to republish their personal post - a post matter.
  social_repost_personal_requested: 'posts',
  social_coorganise_proposed: 'events',
  // A live started by a member or an association the reader follows (WP-L7): a publication of the
  // people the reader follows, so the switch that silences their posts silences their lives too.
  social_live_started: 'posts',
  // A follow request and its acceptance (WP-F4): a category of their own, which the settings screen
  // draws a switch for. Off, the request still waits in the inbox - only the push is not sent.
  social_follow_request: 'follows',
  social_follow_accepted: 'follows',
  form_opening_soon: 'forms',
  form_open: 'forms',
  // A payment landed on a full form, told to its managers: a form matter, filed under the EXISTING
  // id on purpose - a new id would be a category older clients cannot draw a switch for.
  form_paid_over_capacity: 'forms',
  event_proposed: 'events',
  event_validated: 'events',
  event_rejected: 'events',
  event_updated: 'events',
  event_deleted: 'events',
  event_pending: 'events',
};

/**
 * The category a non-MLS push (`/internal/push/notify`, `mls/notify-reaction`) belongs to, or null
 * when it belongs to none and must always go out.
 *
 * NULL IS A DECISION, NOT A GAP: `channel_read` is a silent read-state frame, `call_ring` /
 * `call_ring_end` must ring whatever the reader prefers about chat, and the MLS control frames are
 * the machinery that keeps the account decryptable. None of them is "a notification" in the sense a
 * setting means, and filtering one would break a conversation rather than quiet it.
 *
 * The same decision for `social_live_cut`, `social_live_suspended` and `social_live_withdrawn`
 * (WP-L8b), deliberately absent from the map: a moderation sanction on the reader's own account is
 * not a feed the reader chose, and the switch that quiets the posts of the people they follow must
 * not hide that their right to broadcast was suspended.
 */
export function categoryOfDataPush(data: Record<string, string>): NotificationCategory | null {
  if (data.silent === 'true') return null;
  if (data.reaction === 'true') return 'reactions';
  const byKey = data.contentKey ? CATEGORY_BY_CONTENT_KEY[data.contentKey] : undefined;
  if (byKey) return byKey;
  switch (data.type) {
    case 'channel':
      return 'channels';
    case 'form_reminder':
      return 'forms';
    default:
      return null;
  }
}
