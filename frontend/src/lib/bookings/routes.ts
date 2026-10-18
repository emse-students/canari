/**
 * Where the bookings pages live. One place, so a link and the route it opens cannot drift apart.
 */

/** The organiser's editor of one space (WP-B4). */
export function spaceEditorHref(spaceId: string): `/bookings/spaces/${string}/edit` {
  return `/bookings/spaces/${encodeURIComponent(spaceId)}/edit`;
}
