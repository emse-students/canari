import { clientVersionAtLeast } from '../common/client-version';
import { LIVE_MIN_CLIENT_VERSION } from '../lives/live-client-version';
import type { PushContentKey } from './push-content';

/**
 * NEVER SEND A NOTIFICATION TO A CLIENT TOO OLD TO RENDER IT (owner, 2026-11-10).
 *
 * What it costs when nothing says so: `1.6.9` deployed campus trends at 15:49 UTC and every phone
 * still on `1.6.8` drew the new bell rows as "Une notification que cette version de l'application
 * ne peut pas afficher" - a sentence no server change can take back. A build knows exactly the
 * types it was built with (`KNOWN_NOTIFICATION_TYPES` in the frontend, the native `contentKey`
 * tables), so the server must know the FIRST build that knows each one, and compare it with the
 * build the reader runs:
 *
 * - **the bell** (`GET /api/posts/notifications`): the client names its build in
 *   `X-Canari-Client-Version` (`common/client-version.ts`) and the read serves only the rows whose
 *   type's floor it meets ({@link notificationTypesRenderableBy});
 * - **the push**: every push leaves through `PushService.notifyContent`, which writes its content
 *   key's floor ({@link PUSH_KEY_MIN_CLIENT}) as `minAppVersion`; chat-delivery skips each device
 *   whose REGISTERED build (`key_package.deviceAppVersion`) is below it.
 *
 * ADDING A TYPE: give it its floor here - the first release whose build draws it - in the same pull
 * request that adds it to the client. Nothing else is needed, and both maps are ALLOWLISTS that a
 * test holds against the client: `notification-client-floor.spec.ts` fails when a type of the
 * frontend's `KNOWN_NOTIFICATION_TYPES` has no floor here (or one here is unknown to the client),
 * and the compiler fails when a `PushContentKey` has none, or when `createNotification(s)` is handed
 * a type that is not a key of {@link NOTIFICATION_TYPE_MIN_CLIENT}.
 * docs/wiki/legacy-compatibility.md, "Checklist - a NEW notification type".
 */

/**
 * The build a reader is assumed to run when the notifications read names NONE. Every build up to
 * `1.6.9` reads the bell without the header (the header joins the read in `1.6.10`), so a headerless
 * read is one of them - and the types it was served before this rule existed (every floor up to
 * `1.6.9`) stay served to it, as they were: hiding a follow request from a `1.6.9` phone to protect
 * an older one would take away what the reader already has. EVERY TYPE ADDED FROM NOW ON carries a
 * floor above this, so no headerless read ever receives one. It is a FACT about the builds, never a
 * setting: it never moves.
 */
export const HEADERLESS_CLIENT_VERSION = '1.6.9';

/** The first build that draws a campus trend as a suggestion rather than as a person (2026-11-10). */
export const CAMPUS_TREND_MIN_CLIENT_VERSION = '1.6.10';

/**
 * THE FIRST BUILD THAT DRAWS EACH BELL TYPE, `null` for a type every admitted build draws (known by
 * `1.2.9`, the `minClientVersion` floor of 2026-10-29). Read from the release tags
 * (`KNOWN_NOTIFICATION_TYPES` of each `frontend/src/lib/posts/notificationTarget.ts`) on 2026-11-10.
 */
export const NOTIFICATION_TYPE_MIN_CLIENT = {
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
  profile_correction_applied: null,
  profile_correction_refused: null,
  repost_personal_requested: '1.3.1',
  repost_personal_accepted: '1.3.1',
  repost_personal_refused: '1.3.1',
  live_cut: '1.3.1',
  form_paid_over_capacity: '1.4.0',
  live_suspended: '1.4.0',
  live_withdrawn: '1.4.0',
  follow_request: '1.5.1',
  follow_accepted: '1.5.1',
  booking_cancelled: '1.5.1',
  booking_withdrawn: '1.5.1',
  booking_added: '1.5.1',
  booking_reminder: '1.5.1',
  lydia_payments_active: '1.5.3',
  lydia_payments_paused: '1.5.3',
  lydia_refund_issued: '1.5.3',
  member_repost: '1.6.0',
  lydia_cashier_added: '1.6.0',
  event_pending_coorganiser: '1.6.3',
  booking_changed: '1.6.3',
  booking_removed: '1.6.3',
  delegation_revoked: '1.6.3',
  delegation_receiver_not_ready: '1.6.3',
  delegation_resumed: '1.6.3',
  friend_reaction: '1.6.9',
  friend_comment: '1.6.9',
  birthday: '1.6.9',
  booking_open: '1.6.9',
  event_open: '1.6.9',
  // `1.6.9` knew the type and drew it as a PERSON ("Quelqu'un", an "UI" avatar, a colon followed by
  // nothing): the first build that draws it as a suggestion is the floor.
  campus_trend: CAMPUS_TREND_MIN_CLIENT_VERSION,
} as const satisfies Readonly<Record<string, string | null>>;

/** A type a bell row may carry: one whose floor is declared above, and nothing else. */
export type NotificationType = keyof typeof NOTIFICATION_TYPE_MIN_CLIENT;

/** The notices that are a push and never a bell row: a live does not outlive its moment (L3). */
export const PUSH_ONLY_NOTIFICATION_TYPES = ['live_started', 'live_mention'] as const;

/** One of {@link PUSH_ONLY_NOTIFICATION_TYPES}. */
export type PushOnlyNotificationType = (typeof PUSH_ONLY_NOTIFICATION_TYPES)[number];

/**
 * THE FIRST BUILD WHOSE NATIVE TABLES (`CanariFirebaseMessagingService.kt`, `canari_push.mm`, the
 * NSE) COMPOSE EACH PUSH KEY, `null` for a key every admitted build composes. Read from the release
 * tags on 2026-11-10. A device below a key's floor would show the server's French `legacyTitle` - or,
 * for a live, open a route its build answers with a 404 - so it is not rung at all.
 */
export const PUSH_KEY_MIN_CLIENT: Readonly<Record<PushContentKey, string | null>> = {
  social_mention: null,
  social_reply: null,
  social_comment: null,
  social_reaction: null,
  social_association_post: null,
  social_followed_post: null,
  social_association_repost: null,
  social_repost_proposed: null,
  social_coorganise_proposed: null,
  form_opening_soon: null,
  form_open: null,
  event_proposed: null,
  event_validated: null,
  event_rejected: null,
  event_updated: null,
  event_deleted: null,
  event_pending: null,
  social_repost_personal_requested: '1.3.1',
  // The lives floor, stricter than the key: a build below it answers every /lives route with a 404.
  social_live_started: LIVE_MIN_CLIENT_VERSION,
  social_live_cut: '1.4.0',
  social_live_suspended: '1.4.0',
  social_live_withdrawn: '1.4.0',
  form_paid_over_capacity: '1.4.0',
  social_follow_request: '1.5.1',
  social_follow_accepted: '1.5.1',
  social_booking_cancelled: '1.5.1',
  social_booking_withdrawn: '1.5.1',
  social_booking_added: '1.5.1',
  social_booking_reminder: '1.5.1',
  lydia_payments_active: '1.5.3',
  lydia_payments_paused: '1.5.3',
  lydia_refund_issued: '1.5.3',
  social_member_repost: '1.6.0',
  social_booking_changed: '1.6.3',
  social_booking_removed: '1.6.3',
  delegation_revoked: '1.6.3',
  delegation_receiver_not_ready: '1.6.3',
  delegation_resumed: '1.6.3',
  event_pending_coorganiser: '1.6.3',
  social_friend_reaction: '1.6.9',
  social_friend_comment: '1.6.9',
  social_live_mention: '1.6.9',
  social_birthday: '1.6.9',
  social_booking_open: '1.6.9',
  social_event_open: '1.6.9',
  // `1.6.9` composed "Une publication fait réagir votre espace"; "Suggestion : ..." is `1.6.10`'s.
  social_campus_trend: CAMPUS_TREND_MIN_CLIENT_VERSION,
  social_campus_trend_photo: CAMPUS_TREND_MIN_CLIENT_VERSION,
  social_campus_trend_video: CAMPUS_TREND_MIN_CLIENT_VERSION,
};

/**
 * The data key a push carries its floor in. chat-delivery reads and REMOVES it before the send
 * (`MIN_APP_VERSION_DATA_KEY` in its `utils/app-version.ts`; a spec pins the two spellings).
 */
export const MIN_APP_VERSION_DATA_KEY = 'minAppVersion';

/**
 * The bell types a reader running `clientVersion` can draw: every type whose floor it meets. A read
 * that names no build is {@link HEADERLESS_CLIENT_VERSION}; one that names an unreadable build is
 * served the types every admitted build draws (`null` floors) and nothing else - fail closed.
 */
export function notificationTypesRenderableBy(
  clientVersion: string | undefined
): NotificationType[] {
  const version = clientVersion ?? HEADERLESS_CLIENT_VERSION;
  return (Object.keys(NOTIFICATION_TYPE_MIN_CLIENT) as NotificationType[]).filter((type) => {
    const floor: string | null = NOTIFICATION_TYPE_MIN_CLIENT[type];
    return floor === null || clientVersionAtLeast(version, floor) === true;
  });
}
