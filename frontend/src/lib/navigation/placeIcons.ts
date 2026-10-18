import {
  MessageCircle,
  Newspaper,
  Users,
  LayoutDashboard,
  Bell,
  Calendar,
  ShoppingBag,
  ClipboardList,
  CalendarClock,
} from '@lucide/svelte';
import type { AppPlace } from './places';

/**
 * The Lucide glyph each place is drawn with - in `BottomNav` on the web and Android, and rasterised
 * for the native iOS tab bar (`NativeTabBar`), so the two bars show the SAME icon (user, 2026-09-30),
 * and in the desktop sidebar (`AppSidebar`), which carried a copy of this table until WP-B5.
 */
export const PLACE_ICONS = {
  'message-circle': MessageCircle,
  newspaper: Newspaper,
  users: Users,
  'layout-dashboard': LayoutDashboard,
  bell: Bell,
  calendar: Calendar,
  'shopping-bag': ShoppingBag,
  'clipboard-list': ClipboardList,
  'calendar-clock': CalendarClock,
} as const satisfies Record<AppPlace['icon'], unknown>;
