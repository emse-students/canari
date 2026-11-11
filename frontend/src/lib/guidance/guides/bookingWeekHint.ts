import { CalendarPlus, Columns3 } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * A space's booking page: `/bookings/spaces/<id>` and nothing deeper (its `edit` and `manage` pages
 * are the organiser's).
 */
const SPACE_PAGE = /^\/bookings\/spaces\/[^/]+\/?$/;
export const isBookingSpacePage = (pathname: string): boolean => SPACE_PAGE.test(pathname);

/**
 * FIRST-TIME HINT - booking in a space. Both anchors are marked by `SpaceWeek` once the week's first
 * read has landed (`loaded`), so the help never starts on an empty, dimmed grid and a failed read
 * (which draws the error line instead) leaves both steps out. The column step exists only for a
 * space with several columns, the very condition that draws the selector. The week step points at
 * the grid (wide) or the phone's "+" button - each marked by its own render condition, never on an
 * empty week - and says what the
 * sheet it opens lets a first-timer do. No `replay`: one route per space.
 */
export const bookingWeekHint: GuideDefinition = {
  id: 'hint-booking-week',
  kind: 'hint',
  appliesTo: isBookingSpacePage,
  steps: [
    {
      id: 'column',
      anchor: 'bookings.column',
      icon: Columns3,
      title: m.guide_hint_booking_column_title,
      body: m.guide_hint_booking_column_body,
    },
    {
      id: 'week',
      // The control the text names: the phone's icon-only "+" (sticky, above the bar), the wide
      // screen's grid. Each is marked only where it is drawn, so an empty week leaves the step out.
      anchor: {
        byLayout: (layout) => (layout.phone ? 'bookings.week.add' : 'bookings.week'),
      },
      placement: { byLayout: (layout) => (layout.phone ? 'top' : 'auto') },
      icon: CalendarPlus,
      title: m.guide_hint_booking_week_title,
      body: {
        byLayout: (layout) =>
          layout.phone
            ? m.guide_hint_booking_week_body_phone
            : m.guide_hint_booking_week_body_desktop,
      },
    },
  ],
};
