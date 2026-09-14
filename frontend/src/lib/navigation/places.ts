import { m } from '$lib/paraglide/messages';

export interface AppPlace {
  id: string;
  /** Returns the locale-aware label; call at render time, not module init. */
  label: () => string;
  /**
   * The name for a context measured in a QUARTER OF A PHONE SCREEN - the bottom bar, and nothing
   * else. Identical to `label` wherever the full name already fits.
   *
   * A separate name because one string was being asked to work at two widths that are not
   * comparable. The expanded sidebar is `21rem`; a bottom-bar cell at 390px is 97.5px, and at
   * 360px - one of the commonest Android widths - it is 90px. Measured against the app's own
   * compiled CSS at the `--text-2xs` floor (12px, and `app.css` says nothing goes below it):
   * "Tableau de bord" needs 90.2px BOLD, so the tab clipped its own name to "Tableau de bo..." the
   * moment it was selected - selecting a tab was what made its name stop fitting, because the
   * active state goes from weight 500 to 700 and bold text is wider.
   *
   * `bottomNavLabels.test.ts` holds the budget, in every locale.
   */
  shortLabel: () => string;
  /** Returns the locale-aware description; call at render time, not module init. */
  description: () => string;
  icon:
    | 'message-circle'
    | 'newspaper'
    | 'users'
    | 'layout-dashboard'
    | 'bell'
    | 'calendar'
    | 'shopping-bag'
    | 'clipboard-list';
  href: string;
  /** Whether this place appears in the mobile bottom navigation bar. */
  mobileNav: boolean;
}

// Mobile order: Feed | Communities | Chats | Dashboard - the four with `mobileNav`, and the bottom
// bar draws them with `shortLabel`. The desktop sidebar shows all places (mobileNav ignored).
export const APP_PLACES: AppPlace[] = [
  {
    id: 'posts',
    label: () => m.nav_posts_label(),
    shortLabel: () => m.nav_posts_label(),
    description: () => m.nav_posts_desc(),
    icon: 'newspaper',
    href: '/posts',
    mobileNav: true,
  },
  {
    id: 'communities',
    label: () => m.nav_communities_label(),
    shortLabel: () => m.nav_communities_label(),
    description: () => m.nav_communities_desc(),
    icon: 'users',
    href: '/communities',
    mobileNav: true,
  },
  {
    id: 'chat',
    label: () => m.nav_chat_label(),
    shortLabel: () => m.nav_chat_label(),
    description: () => m.nav_chat_desc(),
    icon: 'message-circle',
    href: '/chat',
    mobileNav: true,
  },
  {
    id: 'notifications',
    label: () => m.nav_notifications_label(),
    shortLabel: () => m.nav_notifications_label(),
    description: () => m.nav_notifications_desc(),
    icon: 'bell',
    href: '/notifications',
    mobileNav: false,
  },
  {
    id: 'calendar',
    label: () => m.nav_calendar_label(),
    shortLabel: () => m.nav_calendar_label(),
    description: () => m.nav_calendar_desc(),
    icon: 'calendar',
    href: '/calendar',
    mobileNav: false,
  },
  {
    id: 'forms',
    label: () => m.nav_forms_label(),
    shortLabel: () => m.nav_forms_label(),
    description: () => m.nav_forms_desc(),
    icon: 'clipboard-list',
    href: '/forms',
    mobileNav: false,
  },
  {
    id: 'shop',
    label: () => m.nav_shop_label(),
    shortLabel: () => m.nav_shop_label(),
    description: () => m.nav_shop_desc(),
    icon: 'shopping-bag',
    href: '/shop',
    mobileNav: false,
  },
  {
    id: 'dashboard',
    label: () => m.nav_dashboard_label(),
    shortLabel: () => m.nav_dashboard_short_label(),
    description: () => m.nav_dashboard_desc(),
    icon: 'layout-dashboard',
    href: '/dashboard',
    mobileNav: true,
  },
];

/** Returns the active place ID for the given pathname, or null if no place matches. */
export function resolveActivePlaceId(pathname: string): string | null {
  const exact = APP_PLACES.find(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
  return exact?.id ?? null;
}
