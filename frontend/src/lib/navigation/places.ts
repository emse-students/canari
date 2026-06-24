import { m } from '$lib/paraglide/messages';

export interface AppPlace {
  id: string;
  /** Returns the locale-aware label; call at render time, not module init. */
  label: () => string;
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

// Ordre mobile : Feed | Communautés | Discussions | Notifs | Tableau de bord
// La sidebar desktop affiche toutes les places (mobileNav ignoré).
export const APP_PLACES: AppPlace[] = [
  {
    id: 'posts',
    label: () => m.nav_posts_label(),
    description: () => m.nav_posts_desc(),
    icon: 'newspaper',
    href: '/posts',
    mobileNav: true,
  },
  {
    id: 'communities',
    label: () => m.nav_communities_label(),
    description: () => m.nav_communities_desc(),
    icon: 'users',
    href: '/communities',
    mobileNav: true,
  },
  {
    id: 'chat',
    label: () => m.nav_chat_label(),
    description: () => m.nav_chat_desc(),
    icon: 'message-circle',
    href: '/chat',
    mobileNav: true,
  },
  {
    id: 'notifications',
    label: () => m.nav_notifications_label(),
    description: () => m.nav_notifications_desc(),
    icon: 'bell',
    href: '/notifications',
    mobileNav: false,
  },
  {
    id: 'calendar',
    label: () => m.nav_calendar_label(),
    description: () => m.nav_calendar_desc(),
    icon: 'calendar',
    href: '/calendar',
    mobileNav: false,
  },
  {
    id: 'forms',
    label: () => m.nav_forms_label(),
    description: () => m.nav_forms_desc(),
    icon: 'clipboard-list',
    href: '/forms',
    mobileNav: false,
  },
  {
    id: 'shop',
    label: () => m.nav_shop_label(),
    description: () => m.nav_shop_desc(),
    icon: 'shopping-bag',
    href: '/shop',
    mobileNav: false,
  },
  {
    id: 'dashboard',
    label: () => m.nav_dashboard_label(),
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
