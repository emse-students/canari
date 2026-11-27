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
    | 'clipboard-list'
    | 'calendar-clock'
    | 'mail';
  href: string;
  /** Whether this place appears in the mobile bottom navigation bar. */
  mobileNav: boolean;
  /**
   * A place shown only while its gate is open - the Mail tab (`mail`: the server's switch is on and
   * the account is eligible, `mail/mailClient.svelte.ts`). A gated place is in no static list below;
   * the bars ask {@link shownPlaces} with the gates' current answers.
   */
  gate?: PlaceGate;
}

/** The gates a place may wait on. */
export type PlaceGate = 'mail';

/** The answer of every gate, as the bars read it at render time. */
export type PlaceGates = Readonly<Record<PlaceGate, boolean>>;

// Mobile order: Feed | Communities | Chats | (Mail) | Dashboard - the ones with `mobileNav`, Mail only
// while its gate is open (D10). The bar draws
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
    id: 'mail',
    label: () => m.nav_mail_label(),
    description: () => m.nav_mail_desc(),
    icon: 'mail',
    href: '/mail',
    mobileNav: true,
    gate: 'mail',
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
    id: 'bookings',
    label: () => m.nav_bookings_label(),
    description: () => m.nav_bookings_desc(),
    icon: 'calendar-clock',
    href: '/bookings',
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
 * The four UNGATED places of the phone's bottom bar, in order - what the tab swipe walks and the
 * guided tour points at. The bars themselves draw {@link mobileNavPlaces} (these four, plus Mail
 * while its gate is open), the web bar (`BottomNav`) and the native iOS bar (`NativeTabBar`) from the
 * same function, so the two bars cannot offer different places.
 */
export const MOBILE_NAV_PLACES: AppPlace[] = APP_PLACES.filter((p) => p.mobileNav && !p.gate);

/** `places` without the gated ones whose gate is shut. Pure: the caller reads the gates. */
export function shownPlaces(places: readonly AppPlace[], gates: PlaceGates): AppPlace[] {
  return places.filter((p) => !p.gate || gates[p.gate]);
}

/**
 * The bottom bar's places with the gates' answers: the four fixed ones, and Mail between Chats and
 * the Dashboard while its gate is open. What `BottomNav` and the native iOS bar draw.
 */
export function mobileNavPlaces(gates: PlaceGates): AppPlace[] {
  return shownPlaces(
    APP_PLACES.filter((p) => p.mobileNav),
    gates
  );
}

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
 * The Minesweeper's own screens: the game board and the replay of a game. Like the camera, the board IS
 * the page, so the shell draws nothing around it (owner, 2026-11-25: the game was a modal whose portal,
 * focus trap and history overlay cost frames, and is a page now). The Games page, the tutorial and the
 * rest of `/games` keep the shell.
 */
const FULL_SCREEN_GAME_PATHS = ['/games/play', '/games/replay'] as const;

/**
 * Whether this path draws full screen, with no header and no tab bar: the camera, whose preview IS
 * the page, and the Minesweeper's board and replay. The layout hides its chrome on it as it does for
 * an open conversation on a phone.
 */
export function isFullScreenPlace(pathname: string): boolean {
  return [CAMERA_PLACE.href, ...FULL_SCREEN_GAME_PATHS].some(
    (href) => pathname === href || pathname.startsWith(`${href}/`)
  );
}

/** Returns the active place ID for the given pathname, or null if no place matches. */
export function resolveActivePlaceId(pathname: string): string | null {
  const exact = APP_PLACES.find(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
  return exact?.id ?? null;
}
