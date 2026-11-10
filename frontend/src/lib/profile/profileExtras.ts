import { Log } from '$lib/utils/Log';
import {
  fetchUserMemberships,
  fetchUserParrainage,
  fetchUserRoleHistory,
  type SkyEntourage,
  type UserMembershipRow,
  type UserRoleHistoryRow,
} from '$lib/profile/api';

/** The three reads under a person's profile, each already settled into a value. */
export interface ProfileExtrasReads {
  memberships: Promise<UserMembershipRow[]>;
  roleHistory: Promise<UserRoleHistoryRow[]>;
  parrainage: Promise<SkyEntourage | null>;
}

/**
 * Sends the three reads under a person's profile - associations, role history, entourage - AT ONCE,
 * and hands back one promise per section.
 *
 * WHY (dev, 500 ms RTT, 2026-11-10, `docs/wiki/frontend/weak-network-audit-2026-11-10.md`): the
 * profile page awaited the profile, then each of these in turn - five round trips in a row before
 * the page was whole (memberships at 2.5 s, role history at 3.1 s, entourage at 3.6 s). They need
 * nothing but the id, so the page starts them with the profile read and applies them once the
 * profile is in.
 *
 * NEVER REJECTS: each section is optional, so a failure resolves to that section's empty value
 * after a line saying why - and, being settled at once, it is never an unhandled rejection while
 * the profile read is still on the wire.
 *
 * THE COST, TAKEN KNOWINGLY: the three reads are sent before the profile has answered, so a profile
 * that turns out unreadable (gone, refused) or a page left before it answers has spent three small
 * reads for nothing - their answers are dropped (the page's load token), never shown. Three wasted
 * reads on a rare path against two round trips saved on every profile open.
 */
export function readProfileExtras(userId: string): ProfileExtrasReads {
  return {
    memberships: fetchUserMemberships(userId).catch((e: unknown): UserMembershipRow[] => {
      Log.d('profile.loadMemberships failed', e);
      return [];
    }),
    roleHistory: fetchUserRoleHistory(userId).catch((e: unknown): UserRoleHistoryRow[] => {
      Log.d('profile.loadRoleHistory failed', e);
      return [];
    }),
    parrainage: fetchUserParrainage(userId).catch((e: unknown): SkyEntourage | null => {
      Log.d('profile.loadParrainage failed', e);
      return null;
    }),
  };
}

/**
 * Starts a profile read and its three extras TOGETHER - the extras first, by construction, so no
 * caller can await the profile before they are on the wire. `readProfile` is called once, after the
 * extras left; the page awaits `profile` and then applies `extras`.
 */
export function readProfileWithExtras<P>(
  userId: string,
  readProfile: () => Promise<P>
): { profile: Promise<P>; extras: ProfileExtrasReads } {
  const extras = readProfileExtras(userId);
  return { profile: readProfile(), extras };
}
