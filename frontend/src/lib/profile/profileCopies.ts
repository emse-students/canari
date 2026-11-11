import type { UserProfile } from '$lib/stores/user';
import type { UserMembershipRow, UserRoleHistoryRow } from '$lib/profile/api';
import {
  PROFILES_SLOT,
  localCopiesAccess,
  onLocalCopiesOpen,
  readLocalCopy,
  writeLocalCopy,
} from '$lib/localCopies/localCopyStore.svelte';
import type { FeedStoreAccess } from '$lib/posts/feedStore';
import { onPeerNamesEnded } from '$lib/utils/users/peerNameDirectory';

/**
 * THE PROFILES ALREADY OPENED, DRAWN BEFORE THE SERVER ANSWERS (slow-link chantier, gap 2,
 * 2026-11-11).
 *
 * A person's profile page waited for its read (the audit measured 4.2 s to the header on a slow
 * link) although the device had shown that person before. The last {@link MAX_STORED_PROFILES}
 * profiles opened are kept in ONE slot of the account's sealed store (`localCopyStore`), newest
 * first, and drawn at once; the read replaces them.
 *
 * WHAT IS KEPT: the public profile fields the page draws, the associations and the role history.
 * NOT KEPT: `posts` (a feed's worth of rows, read again anyway), the entourage (other people), and
 * every VERDICT about the reader - the follow status, the block flag - which the page leaves
 * unconfirmed (its actions disabled) until the answer, so a copy never offers a gesture the server
 * has not confirmed.
 */

/** Profiles kept, newest first; the oldest leave when the list is full. */
export const MAX_STORED_PROFILES = 12;

/** One stored profile with the two lists the page draws under it. */
export interface ProfileCopy {
  profile: UserProfile;
  memberships: UserMembershipRow[];
  roleHistory: UserRoleHistoryRow[];
}

/** Id -> copy, in insertion order: the oldest is the first key. */
let entries = new Map<string, ProfileCopy>();
let entriesOwner: string | null = null;
let loaded: Promise<void> | null = null;
let scheduled = false;

function isStoredCopy(value: unknown): value is ProfileCopy {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<ProfileCopy>;
  return (
    !!c.profile &&
    typeof c.profile === 'object' &&
    typeof c.profile.id === 'string' &&
    Array.isArray(c.memberships) &&
    Array.isArray(c.roleHistory)
  );
}

/** The copy as it is sealed: no `posts`. */
export function storableProfileCopy(copy: ProfileCopy): ProfileCopy {
  const { posts: _posts, ...profile } = copy.profile;
  return { ...copy, profile: profile as UserProfile };
}

function scheduleWrite(): void {
  if (scheduled) return;
  scheduled = true;
  // One write per task however many profiles landed in it (a microtask, never a timer).
  queueMicrotask(() => {
    scheduled = false;
    const access = localCopiesAccess();
    if (!access || entriesOwner !== access.userId) return;
    void writeLocalCopy(PROFILES_SLOT, {
      profiles: [...entries.values()].reverse().map(storableProfileCopy),
    });
  });
}

/** Reads the slot into memory once per account. Never rejects. */
function ensureLoaded(access: FeedStoreAccess): Promise<void> {
  if (loaded && entriesOwner === access.userId) return loaded;
  entries = new Map();
  entriesOwner = access.userId;
  const read = readLocalCopy(access, PROFILES_SLOT, (body) => {
    const list = (body as { profiles?: unknown } | null)?.profiles;
    return Array.isArray(list) && list.every(isStoredCopy) ? (list as ProfileCopy[]) : null;
  }).then((stored) => {
    if (entriesOwner !== access.userId) return;
    // Stored newest first; a profile opened since the launch is fresher and stays.
    for (const copy of (stored ?? []).slice(0, MAX_STORED_PROFILES).reverse()) {
      if (!entries.has(copy.profile.id)) entries.set(copy.profile.id, copy);
    }
    while (entries.size > MAX_STORED_PROFILES)
      entries.delete(entries.keys().next().value as string);
    console.log(`[PROFILE-COPIES] ${stored?.length ?? 0} profile(s) read from the device`);
  });
  loaded = read;
  return read;
}

/** A sign-out or a change of account: the profiles leave memory with the account. */
onPeerNamesEnded(() => {
  entries = new Map();
  entriesOwner = null;
  loaded = null;
});

onLocalCopiesOpen((access) => {
  if (entriesOwner !== access.userId) {
    entries = new Map();
    loaded = null;
    entriesOwner = access.userId;
  } else if (entries.size > 0) {
    scheduleWrite(); // the key changed: seal what is held under it
  }
  void ensureLoaded(access);
});

/** The stored copy of `userId`'s profile, or `null` (none, or no key in hand). */
export async function readProfileCopy(userId: string): Promise<ProfileCopy | null> {
  const access = localCopiesAccess();
  if (!access) return null;
  await ensureLoaded(access);
  if (localCopiesAccess()?.userId !== access.userId) return null;
  return entries.get(userId) ?? null;
}

/** Keeps `copy` as the newest profile opened and seals the list. A no-op while no key is in hand. */
export async function rememberProfile(copy: ProfileCopy): Promise<void> {
  const access = localCopiesAccess();
  if (!access) return;
  await ensureLoaded(access);
  if (localCopiesAccess()?.userId !== access.userId) return;
  entries.delete(copy.profile.id);
  entries.set(copy.profile.id, copy);
  while (entries.size > MAX_STORED_PROFILES) entries.delete(entries.keys().next().value as string);
  scheduleWrite();
}

/** Forgets one profile (the server said the account is gone). */
export function forgetProfileCopy(userId: string): void {
  if (entries.delete(userId)) scheduleWrite();
}
