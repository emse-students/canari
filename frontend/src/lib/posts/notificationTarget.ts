import type { PostNotification } from './api';
import { BOOKINGS_HREF } from '$lib/bookings/routes';
import { formResponsesRoute } from '$lib/forms/responsesLink';

/**
 * The author's inbox of republication requests (D38b) - where a `repost_personal_requested`
 * notification and its push (`fr.emse.canari://republication-requests`) both land.
 */
export const REPUBLICATION_REQUESTS_ROUTE = '/notifications/requests';

/**
 * The reader's inbox of follow requests (WP-F4) - where a `follow_request` notification and its push
 * (`fr.emse.canari://follow-requests`) both land.
 */
export const FOLLOW_REQUESTS_ROUTE = '/notifications/follow-requests';

/**
 * The help page a new Lydia cashier is sent to (enrolment lot 3): what Lydia Pro is, what the role
 * allows, and what to do with Lydia's SMS. Also linked from the association's "Caissiers" section.
 */
export const LYDIA_PRO_HELP_ROUTE = '/help/lydia-pro';

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
export function notificationHref(notif: Pick<PostNotification, 'type' | 'postId'>): string | null {
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
    // The types whose `postId` IS a post.
    case 'comment':
    case 'reply':
    case 'reaction':
    case 'mention':
    case 'association_post':
    case 'followed_post':
    case 'association_repost':
    // D38b: the proposer was told the author's answer - the post shows it (carried, or not).
    case 'repost_personal_accepted':
    case 'repost_personal_refused':
      return `/posts/${notif.postId}`;
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
      return BOOKINGS_HREF;
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
  'profile_correction_applied',
  'profile_correction_refused',
  'live_cut',
  'live_suspended',
  'live_withdrawn',
  'follow_request',
  'follow_accepted',
  'booking_cancelled',
  'booking_withdrawn',
  'booking_added',
  'booking_reminder',
  'lydia_payments_active',
  'lydia_payments_paused',
  'lydia_cashier_added',
  'lydia_refund_issued',
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
};

/**
 * WHERE A NOTIFICATION GOES, including the types that need the association's slug first.
 *
 * `lookupSlug` resolves an association id to its slug (`getAssociation`); it is a parameter so the
 * routing stays testable without a network. Null means the type has no destination. A lookup that fails REJECTS - the caller says the
 * notification could not be opened, rather than sending the reader somewhere else.
 */
export async function resolveNotificationHref(
  notif: Pick<PostNotification, 'type' | 'postId'>,
  lookupSlug: (associationId: string) => Promise<string>
): Promise<string | null> {
  const section = ASSOCIATION_QUEUE_TYPES[notif.type];
  if (!section) return notificationHref(notif);
  const slug = await lookupSlug(notif.postId);
  return `/associations/${encodeURIComponent(slug)}/edit/${section}`;
}
