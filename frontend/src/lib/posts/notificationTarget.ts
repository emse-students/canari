import type { PostNotification } from './api';
import type { AppPath } from '$lib/utils/internalPath';
import { BOOKINGS_HREF } from '$lib/bookings/routes';
import { formResponsesRoute } from '$lib/forms/responsesLink';

/**
 * The author's inbox of republication requests (D38b) - where a `repost_personal_requested`
 * notification and its push (`fr.emse.canari://republication-requests`) both land.
 */
export const REPUBLICATION_REQUESTS_ROUTE = '/notifications/requests' satisfies AppPath;

/**
 * The reader's inbox of follow requests (WP-F4) - where a `follow_request` notification and its push
 * (`fr.emse.canari://follow-requests`) both land.
 */
export const FOLLOW_REQUESTS_ROUTE = '/notifications/follow-requests' satisfies AppPath;

/**
 * The help page a new Lydia cashier is sent to (enrolment lot 3): what Lydia Pro is, what the role
 * allows, and what to do with Lydia's SMS. Also linked from the association's "Caissiers" section.
 */
export const LYDIA_PRO_HELP_ROUTE = '/help/lydia-pro' satisfies AppPath;

/**
 * The query parameter naming the comment a post link opens at - written by the server into a
 * comment push (`socialDeepLink` in social-service), by the bell for a row a comment wrote, and read
 * by the post page.
 */
export const POST_COMMENT_PARAM = 'comment';

/**
 * A post's page, opened at one comment when one is named - the one spelling shared by the bell
 * (`notificationHref`) and a notification tap (`appRouteForDeepLink`), so the two land alike.
 */
export function postHref(postId: string, commentId?: string | null): AppPath {
  const route: AppPath = `/posts/${encodeURIComponent(postId)}`;
  return commentId ? `${route}?${POST_COMMENT_PARAM}=${encodeURIComponent(commentId)}` : route;
}

/**
 * WHERE A NOTIFICATION GOES WHEN IT IS OPENED - the one answer, for both surfaces.
 *
 * The bell dropdown and `/notifications` render the same rows and, until this existed, each decided
 * the destination for itself with its own copy of the same ternary. That is the divergence that
 * comes free with a second copy: the row's own body text had already been through it once, reading
 * `@Marie` on the page and `@[a3f2...]` in the dropdown, and a destination is worse - one surface
 * silently sends a reader somewhere the other does not.
 *
 * WHAT `postId` HOLDS DEPENDS ON THE TYPE, which is why this is a switch and not a template. For a
 * post notification it is a post; for a form reminder it is a form; for the agenda's six it is the
 * ASSOCIATION the event belongs to, because a pending event has no page of its own until it is
 * validated. That is also why an event notification lands on a list rather than on the event: the
 * thing the reader has to do is act on it, and the queue is where acting happens.
 */
export function notificationHref(
  notif: Pick<PostNotification, 'type' | 'postId' | 'meta' | 'commentId'>
): AppPath | null {
  switch (notif.type) {
    case 'form_reminder':
      return `/forms/${notif.postId}`;
    // A payment landed on a full form (`postId` is the FORM): its manager is sent to that form's
    // responses, where the paid-over-capacity answer is, not to the page that answers the form.
    case 'form_paid_over_capacity':
      return formResponsesRoute(notif.postId);
    // A calendar manager was told an event is waiting: send them where they can validate it, not to
    // the month view where a pending event is a grey square among thirty.
    case 'event_proposed':
      return '/admin/agenda';
    // The proposer was told what happened to theirs. The answer is already applied, so the agenda
    // is the page that shows it - or shows it gone, for a refusal, a deletion, or a date change
    // that sent a validated event back into the queue.
    case 'event_validated':
    case 'event_rejected':
    case 'event_updated':
    case 'event_deleted':
    case 'event_pending':
      return '/calendar';
    // The same type reaches the organiser, the partners AND the validators; the validators' row
    // (meta.audience, written with the push's 'proposed' action) opens the validation queue like
    // an event proposal, everybody else the agenda.
    case 'event_pending_coorganiser':
      return notif.meta?.audience === 'validators' ? '/admin/agenda' : '/calendar';
    // The answer to a profile correction request: `postId` holds the REQUEST's id, which has no page
    // of its own - the profile is where the corrected data, or the request's state, is shown.
    case 'profile_correction_applied':
    case 'profile_correction_refused':
      return '/profile';
    // An association refunded the reader (Lydia refunds, lot 4): their purchases, where the payment
    // now reads as refunded. `postId` is the association's id, which that page does not need.
    case 'lydia_refund_issued':
      return '/account/purchases';
    // The association's proposal queue is reached by SLUG, which this synchronous function cannot
    // look up: `resolveNotificationHref` owns these two.
    // A member was added as a Lydia cashier: the page saying what Lydia Pro is and what to do next.
    case 'lydia_cashier_added':
      return LYDIA_PRO_HELP_ROUTE;
    case 'repost_proposed':
    case 'coorganise_proposed':
    case 'lydia_payments_active':
    case 'lydia_payments_paused':
    case 'delegation_revoked':
    case 'delegation_receiver_not_ready':
    case 'delegation_resumed':
      return null;
    // D38b: the author was asked to let an association carry a personal post. Their inbox is where
    // the answer is given; `postId` is the post, which the inbox row links to.
    case 'repost_personal_requested':
      return REPUBLICATION_REQUESTS_ROUTE;
    // A person asks to follow the reader (WP-F4): the inbox where it is answered. `postId` is the
    // ASKER's id, never a post.
    case 'follow_request':
      return FOLLOW_REQUESTS_ROUTE;
    // The person the reader asked accepted: their profile. `postId` is that person's id.
    case 'follow_accepted':
      return `/profile/${encodeURIComponent(notif.postId)}`;
    // A followed person's birthday: their profile, where the reader can wish it. `postId` is that
    // person's id (docs/wiki/birthdays.md).
    case 'birthday':
      return `/profile/${encodeURIComponent(notif.postId)}`;
    // The types whose `postId` IS a post.
    case 'comment':
    case 'reply':
    case 'reaction':
    case 'mention':
    case 'association_post':
    case 'followed_post':
    case 'association_repost':
    // WP-F6: a person the reader follows reposted the post.
    case 'member_repost':
    // Engagement WP-9: a person the reader follows reacted to or commented on the post.
    case 'friend_reaction':
    case 'friend_comment':
    // Engagement WP-10: a post of the reader's space took off.
    case 'campus_trend':
    // D38b: the proposer was told the author's answer - the post shows it (carried, or not).
    case 'repost_personal_accepted':
    case 'repost_personal_refused':
      // A row a comment wrote (a comment, a reply, a mention in a comment, a friend's comment)
      // names it since migration 132, and opens the post AT that comment, as its push does.
      return postHref(notif.postId, notif.commentId);
    // A live a moderator cut (`postId` is the live, deleted when it ended): the row tells the
    // broadcaster and goes nowhere - there is no page of a live that no longer exists. The same for
    // the right to broadcast suspended or withdrawn (WP-L8b; `postId` is the member's own id).
    case 'live_cut':
    case 'live_suspended':
    case 'live_withdrawn':
      return null;
    // The bookings' notices (WP-N): `postId` is the BOOKING, which has no page of its own - the
    // reader's bookings are listed on Reservations (a cancelled one there too, marked).
    case 'booking_cancelled':
    case 'booking_withdrawn':
    case 'booking_added':
    case 'booking_reminder':
    case 'booking_changed':
    case 'booking_removed':
      return BOOKINGS_HREF;
    // The openings told to an association's followers (engagement WP-4): `postId` is the booking
    // SPACE, which Reservations lists; for an event it is the EVENT, which the agenda shows.
    case 'booking_open':
      return BOOKINGS_HREF;
    case 'event_open':
      return '/calendar';
    // A type this build does not know has an id of unknown meaning. The old default sent it to
    // `/posts/<id>`, a dead link for anything that is not a post.
    default:
      return null;
  }
}

/**
 * Every notification type this build can render and route. `NotificationRow` and `notificationHref`
 * both reason about exactly this set (a test walks every member through both), so a type outside it is one NEITHER can show or open.
 */
export const KNOWN_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'comment',
  'reply',
  'reaction',
  'mention',
  'form_reminder',
  'form_paid_over_capacity',
  'association_post',
  'followed_post',
  'association_repost',
  'member_repost',
  'friend_reaction',
  'friend_comment',
  'campus_trend',
  'repost_proposed',
  'coorganise_proposed',
  'repost_personal_requested',
  'repost_personal_accepted',
  'repost_personal_refused',
  'event_proposed',
  'event_validated',
  'event_rejected',
  'event_updated',
  'event_deleted',
  'event_pending',
  'event_pending_coorganiser',
  'profile_correction_applied',
  'profile_correction_refused',
  'live_cut',
  'live_suspended',
  'live_withdrawn',
  'follow_request',
  'follow_accepted',
  'birthday',
  'booking_cancelled',
  'booking_withdrawn',
  'booking_added',
  'booking_reminder',
  'booking_changed',
  'booking_removed',
  'booking_open',
  'event_open',
  'lydia_payments_active',
  'lydia_payments_paused',
  'lydia_cashier_added',
  'lydia_refund_issued',
  'delegation_revoked',
  'delegation_receiver_not_ready',
  'delegation_resumed',
]);

/** Whether this build knows how to render and route a notification of this type. */
export function isKnownNotificationType(type: string): boolean {
  return KNOWN_NOTIFICATION_TYPES.has(type);
}

/** Types already reported, so a list of fifty rows of one new type logs ONE line. */
const reportedUnknownTypes: Record<string, true> = {};

/**
 * Says, once per type, that a notification of a type this build does not know reached the screen.
 * A newer server can send one to an older client; the row stays neutral and unlinked, and this line
 * is what tells a reader of the log WHY - never a silent swallow.
 */
export function reportUnknownNotificationType(type: string): void {
  if (reportedUnknownTypes[type]) return;
  reportedUnknownTypes[type] = true;
  console.warn(`[notifications] unknown notification type "${type}": shown neutral, no link`);
}

/**
 * The notification types whose `postId` names an ASSOCIATION BY ID, and whose page is reached by
 * slug - so the destination needs one lookup `notificationHref` cannot make synchronously.
 * `repost_proposed` (D38) and `coorganise_proposed` (D39) send their acceptors to the one proposal
 * queue (section key `republications`, kept because older notifications already link there).
 */
const ASSOCIATION_QUEUE_TYPES: Record<string, string> = {
  repost_proposed: 'republications',
  coorganise_proposed: 'republications',
  // An association's Lydia payments became active / were paused: its payments section.
  lydia_payments_active: 'payments',
  lydia_payments_paused: 'payments',
  // An entity collecting through a payment delegation (a list) was paused or resumed: its
  // delegation section, where it picks a receiver (`/associations/<slug>/edit` of a list forwards
  // to the list route, section kept).
  delegation_revoked: 'delegation',
  delegation_receiver_not_ready: 'delegation',
  delegation_resumed: 'delegation',
};

/**
 * WHERE A NOTIFICATION GOES, including the types that need the association's slug first.
 *
 * `lookupSlug` resolves an association id to its slug (`getAssociation`); it is a parameter so the
 * routing stays testable without a network. Null means the type has no destination. A lookup that fails REJECTS - the caller says the
 * notification could not be opened, rather than sending the reader somewhere else.
 */
export async function resolveNotificationHref(
  notif: Pick<PostNotification, 'type' | 'postId' | 'meta' | 'commentId'>,
  lookupSlug: (associationId: string) => Promise<string>
): Promise<AppPath | null> {
  const section = ASSOCIATION_QUEUE_TYPES[notif.type];
  if (!section) return notificationHref(notif);
  const slug = await lookupSlug(notif.postId);
  return `/associations/${encodeURIComponent(slug)}/edit/${section}`;
}
