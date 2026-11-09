/**
 * WHERE THE READER STANDS WITH EVERYONE A SCREEN NAMES (engagement WP-2): ONE shared, reactive
 * ledger behind the "Suivre" chips (post headers, the directory, association cards) AND the writers
 * of the profile page, the association page and the sent-requests list - every surface reads and
 * writes here, so a follow made on one reads as made on all of them in the session.
 *
 * - A PERSON is read lazily, once per distinct id, and ALL the ids asked for in the same tick leave
 *   in ONE call (`getFollowStatuses`, chunked at the server's cap), flushed by a microtask, never a
 *   timer. A FAILED read is recorded and NOT asked again in this epoch: a retry happens only on a
 *   real event - the connection coming back ({@link retryFailedReads}), a block change, or another
 *   account. (A failure that re-triggered its own readers asked again at once, forever.)
 * - ASSOCIATIONS are one read of `me/following` plus the reader's memberships, shared by every card.
 * - Blocks are one cached read (`listBlockedUsers`); a blocked account is never offered.
 * - AN EPOCH counter ends every read of a previous reader: the ledger is a per-reader cache
 *   (`registerPerReaderCache`), and an answer that left for account A is dropped when it lands
 *   after the switch to B.
 *
 * The writers - {@link askPerson}, {@link withdrawPerson}, {@link leavePerson} and the association
 * pair - write the answer they got; the surfaces keep their own optimistic UI and restore it on a
 * refusal, with the profile's sentences (`describeFollowRefusal`).
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  ensureMyAssociations,
  followAssociation,
  listMyFollowedAssociations,
  unfollowAssociation,
} from '$lib/associations/api';
import { listBlockedUsers, onBlocksChanged } from '$lib/users/blocks';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { currentUserId } from '$lib/stores/user';
import { registerPerReaderCache } from '$lib/utils/sharedCache';
import { refusalCode } from '$lib/utils/apiRefusal';
import { Log } from '$lib/utils/Log';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { describeFollowRefusal, followActionOf, optimisticStatusAfter } from './followButton';
import {
  FOLLOW_REQUEST_ANSWERED,
  FOLLOW_REQUEST_NOT_FOUND,
  FOLLOW_STATUS_BATCH_MAX,
  askToFollow,
  getFollowStatuses,
  leaveFollow,
  withdrawFollowRequest,
  type FollowStatus,
} from './api';

/** A resolved person: where the reader stands, or `null` for neither. */
const persons = new SvelteMap<string, FollowStatus | null>();

/** Bumped whenever what was read is void; every read compares it when it lands. */
const clock = $state({ epoch: 0 });
/** The epoch as plain reads see it (the same number, kept beside the reactive one). */
let epoch = 0;
/** Persons asked for in this epoch (queued, in flight, answered or failed) - never asked twice. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- NOT reactive on purpose: a reactive set read inside a chip effect re-ran it on every failure, forever
const requested = new Set<string>();
/** Persons whose read FAILED in this epoch: asked again only by {@link retryFailedReads}. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive on purpose, as `requested`
const failedPersons = new Set<string>();
const queue: string[] = [];
let flushQueued = false;

const followedAssociations = new SvelteSet<string>();
const memberAssociations = new SvelteSet<string>();
const associationsState = $state<{ loaded: boolean }>({ loaded: false });
let associationsRead: Promise<void> | null = null;
let associationsFailed = false;

const blockedIds = new SvelteSet<string>();
const blocksState = $state<{ loaded: boolean }>({ loaded: false });
let blocksRead: Promise<void> | null = null;
let blocksFailed = false;

let stopWatchingBlocks: (() => void) | null = null;
let stopWatchingReconnect: (() => void) | null = null;

/** Voids everything read so far: the epoch moves, so answers still on their way are dropped. */
function voidReads(): void {
  epoch++;
  clock.epoch = epoch;
  persons.clear();
  requested.clear();
  failedPersons.clear();
  queue.length = 0;
  flushQueued = false;
  followedAssociations.clear();
  memberAssociations.clear();
  associationsState.loaded = false;
  associationsRead = null;
  associationsFailed = false;
  blockedIds.clear();
  blocksState.loaded = false;
  blocksRead = null;
  blocksFailed = false;
}

/** Forgets everything: another account signed in, or the reader signed out (or a test). */
export function resetFollowState(): void {
  voidReads();
  stopWatchingBlocks?.();
  stopWatchingBlocks = null;
  stopWatchingReconnect?.();
  stopWatchingReconnect = null;
}
registerPerReaderCache(resetFollowState);

/** A block or an unblock here: the blocks and every person read are stale (a block severs follows). */
function dropAfterBlockChange(): void {
  Log.d('followState', 'blocks changed: dropping what was read');
  voidReads();
}

/** The connection came back: ask again for exactly what failed, once. */
function retryFailedReads(): void {
  Log.d(
    'followState',
    `reconnect: retrying ${failedPersons.size} persons, associations ${associationsFailed}, blocks ${blocksFailed}`
  );
  for (const id of failedPersons) {
    queue.push(id);
  }
  failedPersons.clear();
  scheduleFlush();
  if (associationsFailed) {
    associationsRead = null;
    associationsFailed = false;
    ensureAssociationsLoaded();
  }
  if (blocksFailed) {
    blocksRead = null;
    blocksFailed = false;
    ensureBlocksLoaded();
  }
}

/** Starts the listeners that end or redo reads - lazily, so merely importing this does nothing. */
function watch(): void {
  if (!stopWatchingBlocks) stopWatchingBlocks = onBlocksChanged(dropAfterBlockChange);
  if (!stopWatchingReconnect) stopWatchingReconnect = connectivity.onReconnect(retryFailedReads);
}

function scheduleFlush(): void {
  if (flushQueued || queue.length === 0) return;
  flushQueued = true;
  queueMicrotask(flush);
}

/** Sends everything queued so far: one call per {@link FOLLOW_STATUS_BATCH_MAX} ids. */
function flush(): void {
  flushQueued = false;
  const mine = epoch;
  while (queue.length > 0) {
    const ids = queue.splice(0, FOLLOW_STATUS_BATCH_MAX);
    getFollowStatuses(ids)
      .then((statuses) => {
        if (mine !== epoch) return;
        for (const id of ids) {
          // A write that landed while the read was out wins: the read is older than the write.
          if (!persons.has(id)) persons.set(id, statuses[id] ?? null);
        }
      })
      .catch((e: unknown) => {
        if (mine !== epoch) return;
        // Unknown stays unknown: no chip is drawn, which is the safe side of "never offer what is
        // already followed". NOT asked again until a reconnect, a block change or a new reader.
        Log.d('followState', `statuses of ${ids.length} failed, not asked again: ${String(e)}`);
        for (const id of ids) failedPersons.add(id);
      });
  }
}

/** Starts resolving `userId` (a no-op when it is known, queued, in flight, or failed this epoch). */
export function ensurePersonStatus(userId: string): void {
  watch();
  if (requested.has(userId)) return;
  requested.add(userId);
  queue.push(userId);
  scheduleFlush();
}

/** Starts the one read of the followed associations and memberships (a no-op once started). */
export function ensureAssociationsLoaded(): void {
  watch();
  if (associationsRead) return;
  const started = epoch;
  associationsRead = Promise.all([listMyFollowedAssociations(), ensureMyAssociations()])
    .then(([followed, memberships]) => {
      if (started !== epoch) return;
      for (const a of followed) followedAssociations.add(a.id);
      for (const a of memberships) memberAssociations.add(a.id);
      associationsState.loaded = true;
    })
    .catch((e: unknown) => {
      if (started !== epoch) return;
      Log.d('followState', `followed associations failed, not asked again: ${String(e)}`);
      associationsFailed = true;
    });
}

/** Starts the one read of the reader's blocks (a no-op once started). */
export function ensureBlocksLoaded(): void {
  watch();
  if (blocksRead) return;
  const started = epoch;
  blocksRead = listBlockedUsers()
    .then((rows) => {
      if (started !== epoch) return;
      for (const b of rows) blockedIds.add(b.userId);
      blocksState.loaded = true;
    })
    .catch((e: unknown) => {
      if (started !== epoch) return;
      Log.d('followState', `blocks failed, not asked again: ${String(e)}`);
      blocksFailed = true;
    });
}

/**
 * What a chip for a person shows: `undefined` while unknown (draw nothing), `null` for "not
 * following" (draw Suivre), a status otherwise. Self and a blocked account read as `'hidden'`.
 */
export function personChipState(userId: string): FollowStatus | null | undefined | 'hidden' {
  if (!userId || userId === currentUserId()) return 'hidden';
  if (!blocksState.loaded) return undefined;
  if (blockedIds.has(userId)) return 'hidden';
  return persons.get(userId);
}

/**
 * Whether the reader follows `associationId`: `undefined` until the lists are read, and `'hidden'`
 * for one the chip never offers - an association the reader is a member of.
 */
export function associationChipState(associationId: string): boolean | undefined | 'hidden' {
  if (!associationsState.loaded) return undefined;
  if (memberAssociations.has(associationId)) return 'hidden';
  return followedAssociations.has(associationId);
}

/**
 * The ledger's epoch, reactive: an effect that reads it re-runs after a reset (another account, a
 * block change), so a chip still on screen asks again - a derived value that stayed `undefined`
 * would not tell it.
 */
export function followEpoch(): number {
  return clock.epoch;
}

/** Writes what a surface learned of the pair (its own read, or its own write). */
export function recordPersonStatus(userId: string, status: FollowStatus | null): void {
  persons.set(userId, status);
}

/** Writes whether the reader follows `associationId`, as the association page learned it. */
export function recordAssociationFollowed(associationId: string, followed: boolean): void {
  if (followed) followedAssociations.add(associationId);
  else followedAssociations.delete(associationId);
}

/** Asks to follow `userId`; writes and answers the status. Throws the server's refusal. */
export async function askPerson(userId: string): Promise<FollowStatus> {
  const status = await askToFollow(userId);
  recordPersonStatus(userId, status);
  return status;
}

/**
 * Withdraws a request, and answers where the pair stands afterwards: `null` when withdrawn - or
 * when there was none to withdraw (the person refused it: the state is none, nothing to say) - and
 * `'accepted'` when the person accepted meanwhile (the request is a follow now, NOT undone).
 * Anything else is thrown.
 */
export async function withdrawPerson(userId: string): Promise<FollowStatus | null> {
  try {
    await withdrawFollowRequest(userId);
    recordPersonStatus(userId, null);
    return null;
  } catch (err) {
    const code = refusalCode(err);
    if (code === FOLLOW_REQUEST_ANSWERED) {
      Log.d('followState', 'withdraw raced an acceptance: it is a follow now');
      recordPersonStatus(userId, 'accepted');
      return 'accepted';
    }
    if (code === FOLLOW_REQUEST_NOT_FOUND) {
      Log.d('followState', 'withdraw found no request: none');
      recordPersonStatus(userId, null);
      return null;
    }
    throw err;
  }
}

/** Unfollows an accepted follow; writes none. Throws the server's refusal. */
export async function leavePerson(userId: string): Promise<void> {
  await leaveFollow(userId);
  recordPersonStatus(userId, null);
}

/** Follows an association and writes it. Throws on failure. */
export async function followAssociationLedgered(associationId: string): Promise<void> {
  await followAssociation(associationId);
  recordAssociationFollowed(associationId, true);
}

/** Stops following an association and writes it. Throws on failure. */
export async function unfollowAssociationLedgered(associationId: string): Promise<void> {
  await unfollowAssociation(associationId);
  recordAssociationFollowed(associationId, false);
}

/** Taps in flight, by id: a second tap on the same chip while the first is out does nothing. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping of taps in flight, nothing renders from it
const tapping = new Set<string>();

/**
 * The tap on a person's chip: asks, or withdraws a request. The state flips first and is put back
 * on a refusal, whose sentence is the profile's. A withdraw that raced an acceptance or a refusal
 * ends in what the server says now (a follow, or none) - no toast, no stuck state.
 */
export async function tapPerson(userId: string): Promise<void> {
  if (tapping.has(userId)) return;
  const was = persons.get(userId) ?? null;
  const action = followActionOf(was);
  if (action === 'unfollow') return; // an accepted follow is never a chip: unfollowing asks first, on the profile
  tapping.add(userId);
  persons.set(userId, optimisticStatusAfter(action));
  Log.d('followState.tapPerson', `${action} from ${was ?? 'none'}`);
  try {
    if (action === 'ask') await askPerson(userId);
    else await withdrawPerson(userId);
  } catch (err) {
    Log.d('followState.tapPerson failed', err);
    persons.set(userId, was);
    showToast(describeFollowRefusal(refusalCode(err)));
  } finally {
    tapping.delete(userId);
  }
}

/** The tap on an association's chip: follows at once, goes back on a failure. */
export async function tapAssociation(associationId: string): Promise<void> {
  if (tapping.has(associationId) || followedAssociations.has(associationId)) return;
  tapping.add(associationId);
  followedAssociations.add(associationId);
  Log.d('followState.tapAssociation', associationId.slice(0, 8));
  try {
    await followAssociationLedgered(associationId);
  } catch (err) {
    Log.d('followState.tapAssociation failed', err);
    followedAssociations.delete(associationId);
    showToast(m.common_generic_error_label());
  } finally {
    tapping.delete(associationId);
  }
}
