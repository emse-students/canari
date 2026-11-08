/**
 * WHERE THE READER STANDS WITH EVERYONE A SCREEN NAMES (engagement WP-2): one shared, reactive
 * ledger behind every "Suivre" chip - post headers, the directory, association cards - so a follow
 * made on one surface reads as made on all of them at once, and no surface asks the server twice
 * for the same pair.
 *
 * - A PERSON is resolved lazily, once per distinct id, through the existing `follow-status` call
 *   (a feed of fifty posts by ten people costs ten reads, not fifty), at most
 *   {@link MAX_STATUS_READS} at a time. No bulk "who I follow" list exists server-side and none is
 *   needed: nothing here reads a list of persons.
 * - ASSOCIATIONS are one read of `me/following`, shared by every card.
 * - Blocks are one cached read (`listBlockedUsers`); a blocked account is never offered.
 *
 * The state moves on the tap and goes back on a refusal, with the same sentence the profile reads
 * (`describeFollowRefusal`): the profile's rules, not a second set.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { followAssociation, listMyFollowedAssociations } from '$lib/associations/api';
import { listBlockedUsers } from '$lib/users/blocks';
import { currentUserId } from '$lib/stores/user';
import { showToast } from '$lib/stores/toast.svelte';
import { refusalCode } from '$lib/utils/apiRefusal';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';
import { askToFollow, getFollowStatus, leaveFollow, type FollowStatus } from './api';
import { describeFollowRefusal, followActionOf, optimisticStatusAfter } from './followButton';

/** How many `follow-status` reads are in flight at once. */
export const MAX_STATUS_READS = 4;

/** A resolved person: where the reader stands, or `null` for neither. */
const persons = new SvelteMap<string, FollowStatus | null>();
/** Persons whose read is queued or in flight - never read twice. */
const requested = new SvelteSet<string>();
const queue: string[] = [];
let inFlight = 0;

const followedAssociations = new SvelteSet<string>();
const associationsState = $state<{ loaded: boolean }>({ loaded: false });
let associationsRead: Promise<void> | null = null;

const blockedIds = new SvelteSet<string>();
const blocksState = $state<{ loaded: boolean }>({ loaded: false });
let blocksRead: Promise<void> | null = null;

/** Forgets everything: another account signed in, or a test. */
export function resetFollowState(): void {
  persons.clear();
  requested.clear();
  queue.length = 0;
  followedAssociations.clear();
  associationsState.loaded = false;
  associationsRead = null;
  blockedIds.clear();
  blocksState.loaded = false;
  blocksRead = null;
}

function pump(): void {
  while (inFlight < MAX_STATUS_READS && queue.length > 0) {
    const id = queue.shift()!;
    inFlight++;
    getFollowStatus(id)
      .then((status) => {
        // A tap that landed while the read was out wins: the read is older than the tap.
        if (!persons.has(id)) persons.set(id, status);
      })
      .catch((e: unknown) => {
        // Unknown stays unknown: no chip is drawn, which is the safe side of "never offer what is
        // already followed". The id may be asked again on the next mount.
        Log.d('followState', `status of ${id.slice(0, 8)} failed: ${String(e)}`);
        requested.delete(id);
      })
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

/** Starts resolving `userId` (a no-op when it is known, queued or in flight). */
export function ensurePersonStatus(userId: string): void {
  if (requested.has(userId)) return;
  requested.add(userId);
  queue.push(userId);
  pump();
}

/** Starts the one read of the followed associations (a no-op once started). */
export function ensureAssociationsLoaded(): void {
  if (associationsRead) return;
  associationsRead = listMyFollowedAssociations()
    .then((rows) => {
      for (const a of rows) followedAssociations.add(a.id);
      associationsState.loaded = true;
    })
    .catch((e: unknown) => {
      Log.d('followState', `followed associations failed: ${String(e)}`);
      associationsRead = null;
    });
}

/** Starts the one read of the reader's blocks (a no-op once started). */
export function ensureBlocksLoaded(): void {
  if (blocksRead) return;
  blocksRead = listBlockedUsers()
    .then((rows) => {
      for (const b of rows) blockedIds.add(b.userId);
      blocksState.loaded = true;
    })
    .catch((e: unknown) => {
      Log.d('followState', `blocks failed: ${String(e)}`);
      blocksRead = null;
    });
}

/**
 * What a chip for a person shows: `undefined` while unknown (draw nothing), `null` for "not
 * following" (draw Suivre), a status otherwise. Self, a blocked account and an unreadable block
 * list all read as `'hidden'`.
 */
export function personChipState(userId: string): FollowStatus | null | undefined | 'hidden' {
  if (!userId || userId === currentUserId()) return 'hidden';
  if (!blocksState.loaded) return undefined;
  if (blockedIds.has(userId)) return 'hidden';
  return persons.get(userId);
}

/** Whether the reader follows `associationId`, `undefined` until the list is read. */
export function isAssociationFollowed(associationId: string): boolean | undefined {
  return associationsState.loaded ? followedAssociations.has(associationId) : undefined;
}

/**
 * The tap on a person's chip: asks, or withdraws a pending request. The state flips first and goes
 * back on a refusal, whose sentence is the profile's.
 */
export async function tapPerson(userId: string): Promise<void> {
  const was = persons.get(userId) ?? null;
  const action = followActionOf(was);
  if (action === 'unfollow') return; // an accepted follow is never a chip; unfollowing asks first, on the profile
  persons.set(userId, optimisticStatusAfter(action));
  Log.d('followState.tapPerson', `${action} from ${was ?? 'none'}`);
  try {
    if (action === 'ask') persons.set(userId, await askToFollow(userId));
    else await leaveFollow(userId);
  } catch (err) {
    Log.d('followState.tapPerson failed', err);
    persons.set(userId, was);
    showToast(describeFollowRefusal(refusalCode(err)));
  }
}

/** The tap on an association's chip: follows at once, goes back on a failure. */
export async function tapAssociation(associationId: string): Promise<void> {
  if (followedAssociations.has(associationId)) return;
  followedAssociations.add(associationId);
  Log.d('followState.tapAssociation', associationId.slice(0, 8));
  try {
    await followAssociation(associationId);
  } catch (err) {
    Log.d('followState.tapAssociation failed', err);
    followedAssociations.delete(associationId);
    showToast(m.common_generic_error_label());
  }
}
