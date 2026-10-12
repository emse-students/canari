/**
 * THE SECTIONS OF THE READER'S OWN PROFILE, AS ROUTE SEGMENTS (`/profile/me/<section>`).
 *
 * `/profile` used to stack six cards under the identity block (user, 2026-10-10: the profile is a
 * hub of route sections with a clickable breadcrumb, like settings and associations). It is now the
 * identity block plus a row per section, and each card is a page of its own.
 *
 * THE `me` SEGMENT IS THE DISAMBIGUATOR: `/profile/<id>` is somebody else's public profile, and a
 * bare `/profile/<section>` would have made a section key and a user id compete for one segment.
 * No user id is `me`, and `/profile/<id>` sends `me` home to the hub (the id route reads
 * `PROFILE_SELF_SEGMENT`).
 *
 * The segment is user input, so an unknown one is sent back to the hub by the route loader.
 */
import type { Component } from 'svelte';
import {
  Building2,
  Info,
  NotebookPen,
  RotateCcwClock,
  Tag,
  UserRound,
  Users,
} from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { Crumb, HubRow } from '$lib/components/navigation/breadcrumb';

/** The path segment between `/profile/` and the section key; no user id can equal it. */
export const PROFILE_SELF_SEGMENT = 'me';

/** The section keys, in hub order. */
export const PROFILE_SECTIONS = [
  'bio',
  'associations',
  'subscriptions',
  'career',
  'notepad',
  'sponsorship',
  'info',
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

interface ProfileEntry {
  label: () => string;
  icon: Component<{ size?: number }>;
}

/** Each label is the heading the section's own card already carries, so a name exists once. */
const ENTRIES: Record<ProfileSection, ProfileEntry> = {
  bio: { label: () => m.profile_bio_heading(), icon: UserRound },
  associations: { label: () => m.profile_assoc_heading(), icon: Building2 },
  subscriptions: { label: () => m.profile_subs_heading(), icon: Tag },
  career: { label: () => m.profile_career_heading(), icon: RotateCcwClock },
  notepad: { label: () => m.profile_notepad_heading(), icon: NotebookPen },
  sponsorship: { label: () => m.profile_public_sponsorship_heading(), icon: Users },
  info: { label: () => m.profile_info_heading(), icon: Info },
};

/** What the hub already knows, used for the summaries and for which rows exist. */
export interface ProfileHubFacts {
  /** Memberships loaded, `null` while they are not. */
  membershipCount: number | null;
  /** Role-history entries loaded, `null` while they are not. */
  careerCount: number | null;
  /** The sponsorship tree has someone in it. */
  hasSponsorship: boolean;
}

/** Narrows an untrusted string (a URL segment) to a section key. */
export function parseProfileSection(value: string | null | undefined): ProfileSection | null {
  return (PROFILE_SECTIONS as readonly string[]).includes(value ?? '')
    ? (value as ProfileSection)
    : null;
}

/** The localized name of a section: its row, its crumb and its tab title. */
export function profileSectionLabel(section: ProfileSection): string {
  return ENTRIES[section].label();
}

/** The route of the hub (no section) or of one section. */
export function profileSectionHref(section?: ProfileSection | null): string {
  return section ? `/profile/${PROFILE_SELF_SEGMENT}/${section}` : '/profile';
}

/**
 * Whether a section may be opened. Sponsorship is the only one that can be absent: it exists for a
 * reader who has a sponsor or a godchild, exactly as its card did, so a typed `/sponsorship` of
 * someone with none is sent back to the hub. The caller asks only once the tree has loaded.
 */
export function mayOpenProfileSection(section: ProfileSection, facts: ProfileHubFacts): boolean {
  return section !== 'sponsorship' || facts.hasSponsorship;
}

/** The hub's rows, in order, with a count where one is already loaded. */
export function profileHubRows(facts: ProfileHubFacts): HubRow[] {
  const summary = (section: ProfileSection): string | undefined => {
    if (section === 'associations' && facts.membershipCount !== null) {
      return m.profile_hub_associations_summary({ count: facts.membershipCount });
    }
    if (section === 'career' && facts.careerCount !== null) {
      return m.profile_hub_career_summary({ count: facts.careerCount });
    }
    return undefined;
  };
  return PROFILE_SECTIONS.filter((key) => mayOpenProfileSection(key, facts)).map((key) => ({
    key,
    href: profileSectionHref(key),
    label: ENTRIES[key].label(),
    icon: ENTRIES[key].icon,
    summary: summary(key),
  }));
}

/**
 * The path above a section: Profile > Section. Back is the previous crumb, so this function IS the
 * back behaviour of the level; the hub itself has no trail (it is a top-level menu).
 */
export function profileTrail(section: ProfileSection, rootLabel: string): Crumb[] {
  return [
    { label: rootLabel, href: profileSectionHref() },
    { label: ENTRIES[section].label(), href: profileSectionHref(section) },
  ];
}
