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

// Mobile order: Feed | Communities | Chats | Dashboard - the four with `mobileNav`. The bar draws
// NO text (see `BottomNav.svelte`), so `label` is what its `sr-only` name reads; the desktop
// sidebar shows all places and draws `label` visibly (mobileNav ignored).
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

/**
 * The four places of the phone's bottom bar, in order - drawn by `BottomNav` on the web and
 * Android, and handed to the native tab bar on iOS (`NativeTabBar`). One list, so the two bars
 * cannot offer different places.
 */
export const MOBILE_NAV_PLACES: AppPlace[] = APP_PLACES.filter((p) => p.mobileNav);

/**
 * The CanaReels camera (C5): a tab LEFT of the feed, reached by swiping right from it and by nothing
 * else. Deliberately NOT an `AppPlace` in `APP_PLACES` - it has no icon in any bar or sidebar - so it
 * carries only what the swipe list reads (`swipeNavigation.ts`).
 */
export const CAMERA_PLACE = { id: 'camera', href: '/camera' } as const satisfies Pick<
  AppPlace,
  'id' | 'href'
>;

/**
 * Whether this path draws full screen, with no header and no tab bar: the camera, whose preview IS
 * the page. The layout hides its chrome on it as it does for an open conversation on a phone.
 */
export function isFullScreenPlace(pathname: string): boolean {
  return pathname === CAMERA_PLACE.href || pathname.startsWith(`${CAMERA_PLACE.href}/`);
}

/** Returns the active place ID for the given pathname, or null if no place matches. */
export function resolveActivePlaceId(pathname: string): string | null {
  const exact = APP_PLACES.find(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
  return exact?.id ?? null;
}
