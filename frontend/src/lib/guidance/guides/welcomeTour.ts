import {
  CalendarDays,
  Camera,
  MessageCircle,
  Newspaper,
  Sparkles,
  UserRound,
} from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition, GuidePlacement } from '../guideTypes';

/** The desktop rail is a column at the left edge: its bubble goes beside it, the bar's above it. */
const besideTheRail = {
  byLayout: (layout: { phone: boolean }): GuidePlacement => (layout.phone ? 'auto' : 'right'),
};

/**
 * THE WELCOME TOUR - the first guided visit, on the real interface (owner, 2026-11-02): the feed, the
 * chats, the camera, the agenda and the profile, pointed at where they are on THIS layout.
 *
 * The phone's bottom bar and the desktop sidebar both mark their tabs `nav.<place>`, the two headers
 * mark their avatar `nav.profile`, and the iOS app's native bar registers its band under the same
 * ids - so one step serves every layout, and the layout decides which control it lights.
 *
 * Two steps differ by layout, both decided from a fact of the layout, never from the DOM:
 * - THE CAMERA has no control anywhere - it is the tab left of the feed, reached by a swipe - so its
 *   step is a centred bubble miming the swipe, and it exists only where the swipe does.
 * - THE AGENDA has a rail entry on a wide screen and lives in the dashboard on a phone.
 *
 * It starts on the feed, the app's home, where every one of those controls is drawn.
 */
export const welcomeTour: GuideDefinition = {
  id: 'welcome-tour',
  kind: 'tour',
  appliesTo: (pathname) => pathname === '/posts',
  steps: [
    {
      id: 'welcome',
      anchor: null,
      icon: Sparkles,
      title: m.guide_welcome_title,
      body: m.guide_welcome_body,
    },
    {
      id: 'feed',
      anchor: 'nav.posts',
      placement: besideTheRail,
      icon: Newspaper,
      title: m.guide_feed_title,
      body: m.guide_feed_body,
    },
    {
      id: 'chats',
      anchor: 'nav.chat',
      placement: besideTheRail,
      icon: MessageCircle,
      title: m.guide_chats_title,
      body: m.guide_chats_body,
    },
    {
      id: 'camera',
      anchor: null,
      when: (layout) => layout.swipe,
      icon: Camera,
      gesture: 'swipe-right',
      title: m.guide_camera_title,
      body: m.guide_camera_body,
    },
    {
      id: 'agenda',
      anchor: { byLayout: (layout) => (layout.phone ? 'nav.dashboard' : 'nav.calendar') },
      placement: besideTheRail,
      icon: CalendarDays,
      title: m.guide_agenda_title,
      body: {
        byLayout: (layout) =>
          layout.phone ? m.guide_agenda_body_phone : m.guide_agenda_body_desktop,
      },
    },
    {
      id: 'profile',
      anchor: 'nav.profile',
      icon: UserRound,
      title: m.guide_profile_title,
      body: m.guide_profile_body,
    },
  ],
};
