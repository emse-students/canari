/**
 * Where the bookings pages live. One place, so a link and the route it opens cannot drift apart.
 */

/** The Reservations page: my bookings, the listed spaces, my personal spaces (D16, WP-B5). */
export const BOOKINGS_HREF = '/bookings';

/** The booker's page of one space, the link and the QR code hand out (D16, WP-B5). */
export function spaceHref(spaceId: string): `/bookings/spaces/${string}` {
  return `/bookings/spaces/${encodeURIComponent(spaceId)}`;
}

/** The organiser's editor of one space (WP-B4). */
export function spaceEditorHref(spaceId: string): `/bookings/spaces/${string}/edit` {
  return `/bookings/spaces/${encodeURIComponent(spaceId)}/edit`;
}

/** The organiser's dashboard of one space: what is coming, who booked, block by drag (WP-R5, D50). */
export function spaceDashboardHref(spaceId: string): `/bookings/spaces/${string}/manage` {
  return `/bookings/spaces/${encodeURIComponent(spaceId)}/manage`;
}
