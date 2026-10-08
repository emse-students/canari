/**
 * THE PAGES OF THE ADMINISTRATION AREA, THE GROUP EACH BELONGS TO, AND WHO MAY OPEN EACH.
 *
 * ONE table feeds three things that used to be three expressions: the hub (which rows to draw),
 * the layout's guard (whether a typed URL may render) and the breadcrumb (the path above a page).
 * The strip of links and the dropdown groups it replaced each re-derived the tier rules, and the
 * layout never refused a page at all - the pages guarded themselves one by one. A page a tier
 * cannot open is therefore neither LISTED here nor RENDERED by the layout.
 *
 * The server stays the authority on every write; this is the client declining to draw what the
 * server would refuse to answer.
 */
import type { Component } from 'svelte';
import {
  Activity,
  BookUser,
  Building2,
  CalendarClock,
  CalendarDays,
  CirclePlus,
  Database,
  FileCheckCorner,
  HardDrive,
  History,
  Layers,
  Map,
  ShieldAlert,
  UserCog,
  UserPen,
  Users,
  Wallet,
  Wrench,
} from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { Crumb, HubRow } from '$lib/components/navigation/breadcrumb';

/** The four tiers the console reads, ALREADY FOLDED: a platform administrator holds all four. */
export interface AdminTiers {
  isGlobalAdmin: boolean;
  isSuperAdmin: boolean;
  isModerator: boolean;
  isEventValidator: boolean;
}

export type AdminGroupKey = 'moderation' | 'community' | 'platform' | 'shortcuts';

interface AdminEntry {
  key: string;
  /** An admin route (a prefix of every path below it) or, for a shortcut, any app route. */
  href: string;
  group: AdminGroupKey;
  /** The name in the breadcrumb and on the row. */
  label: () => string;
  /** The line under the label, where the app already has one. */
  summary?: () => string;
  icon: Component<{ size?: number }>;
  may: (t: AdminTiers) => boolean;
}

const GLOBAL = (t: AdminTiers) => t.isGlobalAdmin;
const BDE_OR_GLOBAL = (t: AdminTiers) => t.isGlobalAdmin || t.isSuperAdmin;

/** Every entry, in the order its group lists them. */
const ENTRIES: readonly AdminEntry[] = [
  {
    key: 'agenda',
    href: '/admin/agenda',
    group: 'moderation',
    label: () => m.admin_pending_agenda_label(),
    summary: () => m.admin_card_agenda_desc(),
    icon: CalendarClock,
    may: (t) => t.isEventValidator,
  },
  {
    key: 'moderation',
    href: '/admin/moderation',
    group: 'moderation',
    label: () => m.admin_reported_posts_label(),
    summary: () => m.admin_card_moderation_desc(),
    icon: ShieldAlert,
    may: (t) => t.isGlobalAdmin || t.isModerator,
  },
  {
    key: 'spaces',
    href: '/admin/spaces',
    group: 'community',
    label: () => m.admin_spaces_label(),
    icon: Layers,
    may: GLOBAL,
  },
  {
    key: 'read-access',
    href: '/admin/read-access',
    group: 'community',
    label: () => m.readaccess_nav_label(),
    summary: () => m.readaccess_card_desc(),
    icon: FileCheckCorner,
    may: BDE_OR_GLOBAL,
  },
  {
    key: 'carte',
    href: '/admin/carte',
    group: 'community',
    label: () => m.carte_card_label(),
    summary: () => m.carte_card_desc(),
    icon: Map,
    may: BDE_OR_GLOBAL,
  },
  {
    key: 'platform',
    href: '/admin/platform',
    group: 'platform',
    label: () => m.admin_platform_label(),
    summary: () => m.admin_card_platform_desc(),
    icon: Wrench,
    may: GLOBAL,
  },
  {
    key: 'users',
    href: '/admin/users',
    group: 'platform',
    label: () => m.admin_card_manage_admins_label(),
    summary: () => m.admin_card_users_desc(),
    icon: UserCog,
    may: GLOBAL,
  },
  {
    key: 'profile-corrections',
    href: '/admin/profile-corrections',
    group: 'platform',
    label: () => m.profile_corrections_nav_label(),
    summary: () => m.profile_corrections_card_desc(),
    icon: UserPen,
    may: GLOBAL,
  },
  {
    key: 'status',
    href: '/admin/status',
    group: 'platform',
    label: () => m.admin_presence_connections_label(),
    summary: () => m.admin_card_status_desc(),
    icon: Activity,
    may: GLOBAL,
  },
  {
    key: 'cercle',
    href: '/admin/cercle',
    group: 'platform',
    label: () => m.admin_cercle_label(),
    icon: Wallet,
    may: GLOBAL,
  },
  {
    key: 'storage',
    href: '/admin/storage',
    group: 'platform',
    label: () => m.admin_storage_label(),
    summary: () => m.admin_card_storage_desc(),
    icon: HardDrive,
    may: GLOBAL,
  },
  {
    key: 'database',
    href: '/admin/database',
    group: 'platform',
    label: () => m.admin_database_label(),
    summary: () => m.admin_card_database_desc(),
    icon: Database,
    may: GLOBAL,
  },
  {
    key: 'legacy-cotisations',
    href: '/admin/legacy-cotisations',
    group: 'platform',
    label: () => m.admin_legacy_label(),
    summary: () => m.admin_card_legacy_desc(),
    icon: History,
    may: GLOBAL,
  },
  // Not admin pages: the links the dashboard-for-admins always carried, kept on the hub only.
  {
    key: 'directory',
    href: '/directory',
    group: 'shortcuts',
    label: () => m.directory_heading(),
    summary: () => m.directory_subtitle(),
    icon: BookUser,
    may: () => true,
  },
  {
    key: 'associations',
    href: '/associations',
    group: 'shortcuts',
    label: () => m.admin_card_associations_label(),
    summary: () => m.admin_card_associations_desc(),
    icon: Users,
    may: GLOBAL,
  },
  {
    key: 'create-association',
    href: '/associations/new',
    group: 'shortcuts',
    label: () => m.admin_card_create_association_label(),
    summary: () => m.admin_card_create_association_desc(),
    icon: CirclePlus,
    may: GLOBAL,
  },
  {
    key: 'calendar',
    href: '/calendar',
    group: 'shortcuts',
    label: () => m.admin_card_global_calendar_label(),
    summary: () => m.admin_card_calendar_desc(),
    icon: CalendarDays,
    may: GLOBAL,
  },
];

const GROUPS: readonly {
  key: AdminGroupKey;
  label: () => string;
  icon: Component<{ size?: number }>;
}[] = [
  { key: 'moderation', label: () => m.admin_group_moderation_label(), icon: ShieldAlert },
  { key: 'community', label: () => m.admin_group_community_label(), icon: Building2 },
  { key: 'platform', label: () => m.admin_group_platform_label(), icon: Wrench },
  { key: 'shortcuts', label: () => m.admin_group_shortcuts_label(), icon: BookUser },
];

/** The anchor of a group's heading on the hub: what the group crumb links to. */
export function adminGroupHref(group: AdminGroupKey): string {
  return `/admin#group-${group}`;
}

/** An admin route is `/admin/<entry>` or anything below it; never a mere string prefix. */
function underEntry(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/** The entry owning an `/admin/...` path (the longest match), or `undefined` for the hub itself. */
function entryForPath(path: string): AdminEntry | undefined {
  return ENTRIES.filter((e) => e.group !== 'shortcuts' && underEntry(path, e.href)).sort(
    (a, b) => b.href.length - a.href.length
  )[0];
}

/**
 * Whether `path` may render for a reader holding `tiers`. The hub is open to anyone the layout
 * admitted; an admin page needs its entry's tier; a path matching NO entry is refused too, so a
 * typo or a page added without an entry fails closed rather than open.
 */
export function mayOpenAdminPath(path: string, tiers: AdminTiers): boolean {
  if (path === '/admin' || path === '/admin/') return true;
  const entry = entryForPath(path);
  return entry !== undefined && entry.may(tiers);
}

/** The groups the hub draws, each with only the rows `tiers` may open; empty groups vanish. */
export function adminHubGroups(
  tiers: AdminTiers,
  summaries: Record<string, string> = {}
): { key: AdminGroupKey; label: string; rows: HubRow[] }[] {
  return GROUPS.map((g) => ({
    key: g.key,
    label: g.label(),
    rows: ENTRIES.filter((e) => e.group === g.key && e.may(tiers)).map((e): HubRow => ({
      key: e.key,
      href: e.href,
      label: e.label(),
      summary: summaries[e.key] ?? e.summary?.(),
      icon: e.icon,
    })),
  })).filter((g) => g.rows.length > 0);
}

/**
 * The path above an admin page: `Admin > Group > Page` (and one more crumb for the cartography's
 * editor). Every crumb is a link - the group's leads to its heading on the hub - and the arrow is
 * the previous crumb, so this function IS the back behaviour of every level. `undefined` on the
 * hub itself, which has no level above.
 */
export function adminTrail(path: string, rootLabel: string): Crumb[] | undefined {
  const entry = entryForPath(path);
  if (!entry) return undefined;
  const group = GROUPS.find((g) => g.key === entry.group)!;
  const trail: Crumb[] = [
    { label: rootLabel, href: '/admin' },
    { label: group.label(), href: adminGroupHref(group.key) },
    { label: entry.label(), href: entry.href },
  ];
  if (path !== entry.href) {
    trail.push({ label: m.admin_crumb_carte_editor(), href: path });
  }
  return trail;
}
