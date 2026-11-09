import { CalendarCheck, CalendarClock } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - the Reservations page (`/bookings`). Two steps, each on a section the page draws
 * once it has loaded: the reader's coming bookings (`bookings.mine`, always drawn after the load)
 * and the list of spaces (`bookings.spaces`, drawn only when the read succeeded and the list is not
 * empty - else the step is left out, not-rendered). The page loads after the route settles, so the
 * help starts when its anchors mount. Replayable from Settings: the route is fixed.
 */
export const bookingSpacesHint: GuideDefinition = {
  id: 'hint-booking-spaces',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/bookings',
  replay: { label: m.bookings_page_title, route: '/bookings' },
  steps: [
    {
      id: 'mine',
      anchor: 'bookings.mine',
      icon: CalendarCheck,
      title: m.guide_hint_booking_mine_title,
      body: m.guide_hint_booking_mine_body,
    },
    {
      id: 'spaces',
      anchor: 'bookings.spaces',
      icon: CalendarClock,
      title: m.guide_hint_booking_spaces_title,
      body: m.guide_hint_booking_spaces_body,
    },
  ],
};
