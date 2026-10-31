/**
 * THE DASHBOARD: THE APP'S ONE HUB, ITS GROUPS, ITS ROWS AND WHO SEES EACH.
 *
 * On a phone the dashboard is the fourth tab and the ONLY way to Agenda, Associations, Boutique,
 * Formulaires, Reservations and Administration (they are `mobileNav: false` in `places.ts`): it is the app's
 * menu. It was a launcher of tiles, buttons calling `goto` and a theme toggle; it is now one
 * `SectionHub` per group, rows as real links, the same shape on a phone and on a desktop
 * (docs/wiki/frontend/section-navigation.md, UI-1 of the 2026-10-16 UI redesign audit).
 *
 * ONE table, read by the page and by its test, so a row and the rule that shows it are one
 * decision. This table only LINKS: who may OPEN a page is each page's own guard, unchanged here.
 * The directory is linked where it was linked before (the reader who reaches the admin hub, whose
 * shortcuts carry it), not wider.
 *
 * Every fact below is already held when the page renders or arrives from a probe the page made
 * before this hub existed - no row costs a request of its own.
 */
import type { Component } from 'svelte';
import {
  Bell,
  BookUser,
  Building2,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  FolderOpen,
  Landmark,
  LogOut,
  Settings,
  Shield,
  ShoppingBag,
  UserRound,
  Users,
} from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { Association } from '$lib/associations/api';
import { groupAssociationsForSelect } from '$lib/associations/selectGroups';
import { editSectionHref } from '$lib/associations/editSections';
import type { AdminScopeLabels } from '$lib/admin/access';
import type { HubRow } from '$lib/components/navigation/breadcrumb';

/**
 * The groups, top to bottom. Identity, Explorer and Compte read nothing a probe returns and draw on
 * the first frame - Compte above all: SIGN-OUT IS ALWAYS REACHABLE, whatever a probe does, even one
 * that never answers. The probed groups (managed associations, administration, the reviewer's
 * documents) sit between Explorer and Compte and draw once every probe has SETTLED - answered,
 * failed or given up - all at once, never a row at a time, and with no space reserved for them, so
 * their arrival can only push Compte DOWN (a reserved row collapsing for a member pulled sign-out up
 * under a finger aimed at settings).
 */
export type DashboardGroupKey =
  | 'identity'
  | 'explore'
  | 'managed'
  | 'managedLists'
  | 'managedInstitutions'
  | 'admin'
  | 'review'
  | 'account';

/** The managed groups, one per kind: each under its own heading, never mixed. */
type ManagedKey = 'managed' | 'managedLists' | 'managedInstitutions';

const MANAGED_KEYS: readonly DashboardGroupKey[] = [
  'managed',
  'managedLists',
  'managedInstitutions',
];

/** The groups drawn before the probes settle: they read nothing a probe returns. */
const SETTLED_FREE: readonly DashboardGroupKey[] = ['identity', 'explore', 'account'];

/** What the dashboard knows about its reader. */
export interface DashboardFacts {
  /** The signed-in reader, for the identity row; `null` draws it without an avatar. */
  userId: string | null;
  /** The saved display name, or `null` before one is known. */
  displayName: string | null;
  /** Unread notifications, from `postNotifStore` - never fetched for the dashboard. */
  unreadNotifications: number;
  /** `ensureMayOpenAdmin()`: the same predicate the `/admin` layout admits on. */
  mayOpenAdmin: boolean;
  /** What the console is called for this reader (`adminScopeLabels`). */
  adminScope: AdminScopeLabels;
  /** `getReviewerAccess()`: may read every association's public documents. */
  isReviewer: boolean;
  /** The reader's memberships (`ensureMyAssociations`), `[]` until they arrive. */
  memberships: readonly Association[];
  /** Every probe above has answered (or failed, logged); until then only the free groups draw. */
  probesSettled: boolean;
  /** A sign-out is in flight; the sign-out row is disabled meanwhile. */
  signingOut?: boolean;
}

/** The page's handlers for the action rows; a table cannot hold a closure over page state. */
export interface DashboardActions {
  signOut: () => void;
}

interface DashboardEntry {
  key: string;
  group: Exclude<DashboardGroupKey, ManagedKey>;
  /** A route, or `signOut` for the one row that is an action rather than a place. */
  target: string | { action: keyof DashboardActions };
  label: (f: DashboardFacts) => string;
  summary?: (f: DashboardFacts) => string;
  icon: Component<{ size?: number }>;
  tone?: HubRow['tone'];
  /** Who sees the row; absent means every signed-in reader. */
  may?: (f: DashboardFacts) => boolean;
}

/** Every static row, in the order its group lists it. */
const ENTRIES: readonly DashboardEntry[] = [
  {
    key: 'profile',
    group: 'identity',
    target: '/profile',
    label: (f) => f.displayName || m.profile_default_name(),
    summary: () => m.dashboard_identity_summary(),
    icon: UserRound,
  },
  {
    key: 'calendar',
    group: 'explore',
    target: '/calendar',
    label: () => m.nav_calendar_label(),
    summary: () => m.nav_calendar_desc(),
    icon: CalendarDays,
  },
  {
    key: 'associations',
    group: 'explore',
    target: '/associations',
    label: () => m.assoc_list_heading(),
    summary: () => m.assoc_list_subtitle(),
    icon: Users,
  },
  {
    key: 'lists',
    group: 'explore',
    target: '/lists',
    label: () => m.list_heading(),
    summary: () => m.list_subtitle(),
    icon: Building2,
  },
  {
    key: 'institutions',
    group: 'explore',
    target: '/institutions',
    label: () => m.inst_heading(),
    summary: () => m.inst_subtitle(),
    icon: Landmark,
  },
  {
    key: 'shop',
    group: 'explore',
    target: '/shop',
    label: () => m.nav_shop_label(),
    summary: () => m.nav_shop_desc(),
    icon: ShoppingBag,
  },
  {
    key: 'forms',
    group: 'explore',
    target: '/forms',
    label: () => m.nav_forms_label(),
    summary: () => m.nav_forms_desc(),
    icon: ClipboardList,
  },
  {
    // D37: the phone reaches Reservations from here, no bottom tab displaced.
    key: 'bookings',
    group: 'explore',
    target: '/bookings',
    label: () => m.nav_bookings_label(),
    summary: () => m.nav_bookings_desc(),
    icon: CalendarClock,
  },
  {
    key: 'notifications',
    group: 'explore',
    target: '/notifications',
    label: () => m.nav_notifications_label(),
    summary: () => m.nav_notifications_desc(),
    icon: Bell,
  },
  {
    key: 'directory',
    group: 'explore',
    target: '/directory',
    label: () => m.directory_heading(),
    summary: () => m.directory_subtitle(),
    icon: BookUser,
    // Arrives with the probed groups, not alone: one change below Explorer, never two.
    may: (f) => f.probesSettled && f.mayOpenAdmin,
  },
  {
    key: 'admin',
    group: 'admin',
    target: '/admin',
    label: (f) => f.adminScope.title(),
    summary: (f) => f.adminScope.description(),
    icon: Shield,
    may: (f) => f.mayOpenAdmin,
  },
  {
    key: 'settings',
    group: 'account',
    target: '/settings',
    label: () => m.settings_page_title(),
    summary: () => m.settings_page_subtitle(),
    icon: Settings,
  },
  {
    // Not in Compte: it hangs on a probe, and arriving there it would push sign-out down.
    key: 'documents',
    group: 'review',
    target: '/documents',
    label: () => m.reviewer_docs_title(),
    summary: () => m.reviewer_docs_subtitle(),
    icon: FolderOpen,
    may: (f) => f.isReviewer,
  },
  // The rarest, most destructive gesture: last, ordinary size, the danger tone the settings hub
  // gives "Delete my account" - no longer the largest target on the screen.
  {
    key: 'sign-out',
    group: 'account',
    target: { action: 'signOut' },
    label: () => m.dashboard_signout_label(),
    icon: LogOut,
    tone: 'danger',
  },
];

/** One managed organisation as a row: its logo when it has one, its kind's glyph otherwise. */
function managedRow(a: Association): HubRow {
  return {
    key: `managed-${a.id}`,
    href: editSectionHref(a.slug, null, a.type === 'list' ? '/lists' : '/associations'),
    label: a.name,
    summary: a.role || undefined,
    icon: a.type === 'list' ? Building2 : a.type === 'institution' ? Landmark : Users,
    logo: { id: a.id, name: a.name, logoUrl: a.logoUrl },
  };
}

/**
 * The organisations of ONE kind the reader MANAGES (a live membership holding at least one right:
 * `isAdmin`, which `/api/associations/me/list` sets from the bitmask - the same test the
 * association page applies to its own "Manage" link). THE KIND IS `groupAssociationsForSelect`'s,
 * the ONE classifier every picker uses; it also leaves archived rows out. Each kind is its OWN
 * group under its own heading: "Mes associations" holds associations only (user, 2026-10-18). A
 * list's management area lives under `/lists`.
 */
function managedRows(memberships: readonly Association[], key: ManagedKey): HubRow[] {
  const { assos, lists, institutions } = groupAssociationsForSelect(
    memberships.filter((a) => a.isAdmin)
  );
  const kind = key === 'managed' ? assos : key === 'managedLists' ? lists : institutions;
  return kind.map(managedRow);
}

/** The heading of each group; the identity row stands alone, under no heading. */
function groupLabel(key: DashboardGroupKey, f: DashboardFacts): string {
  switch (key) {
    case 'identity':
      return m.dashboard_profile_label();
    case 'explore':
      return m.dashboard_explore_heading();
    case 'managed':
      return m.dashboard_managed_heading();
    case 'managedLists':
      return m.dashboard_managed_lists_heading();
    case 'managedInstitutions':
      return m.dashboard_managed_institutions_heading();
    case 'admin':
      return f.adminScope.title();
    case 'review':
      return m.reviewer_docs_title();
    case 'account':
      return m.dashboard_account_heading();
  }
}

const GROUP_ORDER: readonly DashboardGroupKey[] = [
  'identity',
  'explore',
  'managed',
  'managedLists',
  'managedInstitutions',
  'admin',
  'review',
  'account',
];

/**
 * Groups drawn with no visible heading: the identity row stands alone, and the admin and review
 * groups' one row already says what the heading would, so a heading would repeat it. The label
 * still names the list for assistive technology.
 */
const HEADINGLESS: readonly DashboardGroupKey[] = ['identity', 'admin', 'review'];

/** One group as the page draws it. */
export interface DashboardGroup {
  key: DashboardGroupKey;
  label: string;
  heading: boolean;
  rows: HubRow[];
}

/**
 * The groups the dashboard draws for `facts`, each with only its visible rows; empty ones vanish.
 * Before the probes settle, only the groups that read none of them (`SETTLED_FREE`).
 */
export function dashboardHubGroups(
  facts: DashboardFacts,
  actions: DashboardActions
): DashboardGroup[] {
  return GROUP_ORDER.filter((key) => facts.probesSettled || SETTLED_FREE.includes(key))
    .map((key) => {
      const rows = MANAGED_KEYS.includes(key)
        ? managedRows(facts.memberships, key as ManagedKey)
        : ENTRIES.filter((e) => e.group === key && (e.may?.(facts) ?? true)).map((e) =>
            toRow(e, facts, actions)
          );
      return {
        key,
        label: groupLabel(key, facts),
        heading: !HEADINGLESS.includes(key),
        rows,
      };
    })
    .filter((g) => g.rows.length > 0);
}

/** An entry as a hub row: a link, or the action the page handed in. */
function toRow(e: DashboardEntry, f: DashboardFacts, actions: DashboardActions): HubRow {
  const base = {
    key: e.key,
    label: e.label(f),
    summary: e.summary?.(f),
    tone: e.tone,
  };
  // The reader's own row leads with their avatar; without a known id, with the glyph.
  const lead = e.key === 'profile' && f.userId ? { avatarUserId: f.userId } : { icon: e.icon };
  const row: HubRow =
    typeof e.target === 'string'
      ? { ...base, ...lead, href: e.target }
      : { ...base, ...lead, onSelect: actions[e.target.action], busy: f.signingOut };
  if (e.key === 'notifications' && f.unreadNotifications > 0) {
    row.badge = f.unreadNotifications;
    row.badgeLabel = m.dashboard_unread_notifications_label({ count: f.unreadNotifications });
  }
  return row;
}
