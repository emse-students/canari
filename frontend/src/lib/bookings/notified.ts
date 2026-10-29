/**
 * WHETHER A BOOKING CHANGE IS TOLD TO ITS PEOPLE (WP-N, D53): the client's mirror of the server's
 * `BOOKING_NOTIFICATIONS_ENABLED` (`apps/social-service/src/bookings/booking-notifications.service.ts`),
 * which `notified.contract.test.ts` reads so the two cannot disagree.
 *
 * Off, the server writes and sends nothing, and the screens keep D13's sentences ("nobody is
 * told"), which are then true; the reminder settings are not offered, since nothing would send
 * them. On, the screens say who is told and offer the reminder. Both flip in ONE pull request,
 * once `minClientVersion` covers a client that knows the four types (docs/wiki/legacy-compatibility.md).
 */
export const BOOKING_NOTIFICATIONS_LIVE = true;
