/**
 * WHERE THE READER STANDS WITH EVERYONE A SCREEN NAMES (engagement WP-2): ONE shared, reactive
 * ledger behind the "Suivre" chips (post headers, the directory, association cards) AND the writers
 * of the profile page, the association page and the sent-requests list - every surface reads and
 * writes here, so a follow made on one reads as made on all of them in the session.
 *
 * - A PERSON is read lazily, once per distinct id, and ALL the ids asked for in the same tick leave
 *   in ONE call (`getFollowStatuses`, chunked at the server's cap), flushed by a microtask, never a
 *   timer. A FAILED read is recorded and NOT asked again in this epoch: a retry happens only on a
 *   real event - the connection coming back ({@link retryFailedFollowReads}), a block change, or another
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
  didMyAssociationsProbeFail,
  ensureMyAssociations,
  followAssociation,
  getAssociationFollowStatus,
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
/** Persons whose read FAILED in this epoch: asked again only by {@link retryFailedFollowReads}. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive on purpose, as `requested`
const failedPersons = new Set<string>();
/** Taps in flight, by id: a second tap on the same chip while the first is out does nothing. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping of taps in flight, nothing renders from it
const tapping = new Set<string>();
/**
 * The same taps, REACTIVE: a surface that must not react to the optimistic flip (a suggestion card
 * stays drawn until the server has answered, so a refusal never makes it vanish and come back)
 * reads {@link isTapSettling}.
 */
const settling = new SvelteSet<string>();
/** Whether a tap on `id` is still out: the server has not answered yet. */
export function isTapSettling(id: string): boolean {
  return settling.has(id);
}
const queue: string[] = [];
/**
 * The status calls of the current round, one token each. While any is out, newly queued ids WAIT and
 * leave together (see `flush`). A SET OF TOKENS, not a counter: the gate can be emptied by an event
 * ({@link voidReads}, a reconnect) while a call it abandoned is still out, and that call's late end
 * must remove only its own token - never open the gate on a round that is not its own.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, nothing renders from it
const roundsOut = new Set<object>();
let flushQueued = false;

const followedAssociations = new SvelteSet<string>();
const memberAssociations = new SvelteSet<string>();
/** `membershipKnown` is false when the membership probe FAILED: then nothing is offered (see below). */
const associationsState = $state<{ loaded: boolean; membershipKnown: boolean }>({
  loaded: false,
  membershipKnown: false,
});
/** Associations a WRITE settled in this epoch: a read that left earlier must not overwrite them. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, nothing renders from it
const writtenAssociations = new Set<string>();
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
  // A tap still out belongs to the reader who made it; the next one is not blocked by it.
  tapping.clear();
  settling.clear();
  queue.length = 0;
  flushQueued = false;
  // A call of the reader who left is still out; the new reader must not wait behind it.
  roundsOut.clear();
  followedAssociations.clear();
  memberAssociations.clear();
  writtenAssociations.clear();
  associationsState.loaded = false;
  associationsState.membershipKnown = false;
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

/**
 * A status round still out no longer holds the gate once a real event says waiting for it is moot
 * (a navigation, the connection back): what queued behind it leaves now. The abandoned call's
 * answer, if it lands, is still applied or dropped by the epoch check. One line when it did
 * release something, none when the gate was empty - which is nearly always.
 */
function releaseStatusRound(event: string): void {
  if (roundsOut.size === 0) return;
  Log.i('followState', `a status round was still out at ${event} - not waiting for it`);
  roundsOut.clear();
  scheduleFlush();
}

/**
 * A real event (the connection back, a navigation): stop waiting for a status round still out, and
 * ask again for exactly what failed, once.
 */
export function retryFailedFollowReads(event: 'navigation' | 'reconnect' = 'navigation'): void {
  releaseStatusRound(event);
  // Nothing failed in this epoch: nothing to ask again, and nothing to say.
  if (failedPersons.size === 0 && !associationsFailed && !blocksFailed) return;
  Log.d(
    'followState',
    `retrying ${failedPersons.size} persons, associations ${associationsFailed}, blocks ${blocksFailed}`
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

/**
 * A failed read, said where it can be seen: it leaves every chip it fed hidden until a real event
 * (reconnect, navigation, a block change, another account) asks again, so it is a WARNING with the
 * status - an online 5xx is the case no reconnect ever heals.
 */
function warnFailedRead(what: string, err: unknown): void {
  const status = (err as { status?: number } | null)?.status;
  console.warn(
    `[followState] ${what} failed (status ${status ?? 'none'}); chips stay hidden until the next reconnect or navigation`,
    err
  );
}

/** Starts the listeners that end or redo reads - lazily, so merely importing this does nothing. */
function watch(): void {
  if (!stopWatchingBlocks) stopWatchingBlocks = onBlocksChanged(dropAfterBlockChange);
  if (!stopWatchingReconnect) stopWatchingReconnect = connectivity.onReconnect(onReconnect);
}

/**
 * The connection is back: a call that was out across the outage no longer holds the gate (its answer,
 * if it ever lands, is still applied by the epoch check), so what queued behind it leaves now, and
 * what failed is asked again.
 */
function onReconnect(): void {
  retryFailedFollowReads('reconnect');
}

function scheduleFlush(): void {
  if (flushQueued || queue.length === 0) return;
  flushQueued = true;
  queueMicrotask(flush);
}

/**
 * Sends everything queued so far: one call per {@link FOLLOW_STATUS_BATCH_MAX} ids (all the chunks of
 * one round together) - and never while an earlier round is still out.
 *
 * ONE ROUND OF CALLS IN FLIGHT AT A TIME, and that is what turns a feed's cards mounting over a few
 * hundred milliseconds into two calls instead of eight (measured on the owner's `1.6.9` log:
 * `follow-statuses` x8 in one boot, each a few ids). The ids that queue while a round is out leave in
 * ONE call the moment its answers land (`settled`), so the window is the call itself - an exact
 * event, no clock. A chip waits at most one extra round trip, which it can afford: it is a hint
 * drawn after the content, never the content.
 *
 * WHAT BOUNDS A ROUND IS A FACT, NOT A TIMER. Every call is an `apiFetch`, which rejects at its own
 * response-head deadline (a typed `RequestDeadlineError`), and a rejection settles the round like an
 * answer does. The gate is also emptied by the two events that make an outstanding call moot: the
 * reader changing or a block changing ({@link voidReads}), and the connection coming back (the
 * reconnect listener in {@link watch}) - the abandoned call's answer is still applied or dropped by
 * the epoch check, it just no longer holds the gate. What nothing here bounds is a response BODY
 * stalling after its head arrived; that leaves the chips behind it hidden (the safe side) until one
 * of those events, and is the transport's to bound, not a second clock here.
 */
function flush(): void {
  flushQueued = false;
  if (roundsOut.size > 0) return;
  const mine = epoch;
  while (queue.length > 0) {
    const ids = queue.splice(0, FOLLOW_STATUS_BATCH_MAX);
    const token = {};
    roundsOut.add(token);
    const settled = () => {
      roundsOut.delete(token);
      // The ids that queued while this was out go now - even after a reset, whose queue is the new one.
      scheduleFlush();
    };
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
        warnFailedRead(`statuses of ${ids.length} persons`, e);
        for (const id of ids) failedPersons.add(id);
      })
      .finally(settled);
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
      // A read older than a write never overwrites it.
      for (const a of followed) if (!writtenAssociations.has(a.id)) followedAssociations.add(a.id);
      for (const a of memberships) memberAssociations.add(a.id);
      // `ensureMyAssociations` turns a failure into `[]`: that is NOT "belongs to nothing".
      associationsState.membershipKnown = !didMyAssociationsProbeFail();
      associationsState.loaded = true;
    })
    .catch((e: unknown) => {
      if (started !== epoch) return;
      warnFailedRead('followed associations', e);
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
      warnFailedRead('blocks', e);
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
  // Membership unknown: offer nothing rather than offer Suivre on the reader's own association.
  if (!associationsState.membershipKnown) return 'hidden';
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
export function recordPersonStatus(
  userId: string,
  status: FollowStatus | null,
  since: number = epoch
): void {
  if (since !== epoch) {
    Log.d('followState', 'a person status from an earlier epoch is dropped');
    return;
  }
  persons.set(userId, status);
}

/** Writes whether the reader follows `associationId`, as the association page learned it. */
export function recordAssociationFollowed(
  associationId: string,
  followed: boolean,
  since: number = epoch
): void {
  if (since !== epoch) {
    Log.d('followState', 'an association follow from an earlier epoch is dropped');
    return;
  }
  writtenAssociations.add(associationId);
  if (followed) followedAssociations.add(associationId);
  else followedAssociations.delete(associationId);
}

/**
 * Every writer below captures the epoch BEFORE its await and writes (or rolls back) only if it did
 * not move: a tap on account A's screen answered after the switch to B must leave B's ledger alone.
 */

/**
 * The association page's own read of whether the reader follows `associationId`: the ledger learns
 * it ONLY from a real answer (and only if the reader did not change meanwhile). A failed read is
 * said as a warning, writes nothing - it is not "not followed" - and the page, which still needs
 * a value to draw its button, gets `false`.
 */
export async function readAssociationFollowed(associationId: string): Promise<boolean> {
  const at = epoch;
  try {
    const { following } = await getAssociationFollowStatus(associationId);
    recordAssociationFollowed(associationId, following, at);
    return following;
  } catch (err) {
    warnFailedRead('the association follow status', err);
    return false;
  }
}

/** Asks to follow `userId`; writes and answers the status. Throws the server's refusal. */
export async function askPerson(userId: string): Promise<FollowStatus> {
  const at = epoch;
  const status = await askToFollow(userId);
  recordPersonStatus(userId, status, at);
  return status;
}

/**
 * Withdraws a request, and answers where the pair stands afterwards: `null` when withdrawn - or
 * when there was none to withdraw (the person refused it: the state is none, nothing to say) - and
 * `'accepted'` when the person accepted meanwhile (the request is a follow now, NOT undone).
 * Anything else is thrown.
 */
export async function withdrawPerson(userId: string): Promise<FollowStatus | null> {
  const at = epoch;
  try {
    await withdrawFollowRequest(userId);
    recordPersonStatus(userId, null, at);
    return null;
  } catch (err) {
    const code = refusalCode(err);
    if (code === FOLLOW_REQUEST_ANSWERED) {
      Log.d('followState', 'withdraw raced an acceptance: it is a follow now');
      recordPersonStatus(userId, 'accepted', at);
      return 'accepted';
    }
    if (code === FOLLOW_REQUEST_NOT_FOUND) {
      Log.d('followState', 'withdraw found no request: none');
      recordPersonStatus(userId, null, at);
      return null;
    }
    throw err;
  }
}

/** Unfollows an accepted follow; writes none. Throws the server's refusal. */
export async function leavePerson(userId: string): Promise<void> {
  const at = epoch;
  await leaveFollow(userId);
  recordPersonStatus(userId, null, at);
}

/** Follows an association and writes it. Throws on failure. */
export async function followAssociationLedgered(associationId: string): Promise<void> {
  const at = epoch;
  await followAssociation(associationId);
  recordAssociationFollowed(associationId, true, at);
}

/** Stops following an association and writes it. Throws on failure. */
export async function unfollowAssociationLedgered(associationId: string): Promise<void> {
  const at = epoch;
  await unfollowAssociation(associationId);
  recordAssociationFollowed(associationId, false, at);
}

/**
 * The tap on a person's chip: asks, or withdraws a request. The state flips first and is put back
 * on a refusal, whose sentence is the profile's. A withdraw that raced the other side ends in what
 * the server says now (a follow, or none) - no toast, no stuck state. If the reader changed while
 * it was out, nothing is rolled back and nothing is said: that ledger is not this tap's.
 *
 * Answers the status the SERVER returned for an ask (`pending`, or `accepted` if the account took it
 * at once), `null` for anything else (a withdraw, a refusal, a changed reader). It toasts only a
 * refusal: the confirmation is the surface's to word (`FollowChip`), `FollowBackButton` shows its own.
 */
export async function tapPerson(userId: string): Promise<FollowStatus | null> {
  if (tapping.has(userId)) return null;
  const was = persons.get(userId) ?? null;
  const action = followActionOf(was);
  if (action === 'unfollow') return null; // an accepted follow is never a chip: unfollowing asks first, on the profile
  const at = epoch;
  tapping.add(userId);
  settling.add(userId);
  persons.set(userId, optimisticStatusAfter(action));
  Log.d('followState.tapPerson', `${action} from ${was ?? 'none'}`);
  try {
    if (action !== 'ask') {
      await withdrawPerson(userId);
      return null;
    }
    const status = await askPerson(userId);
    return at === epoch ? status : null;
  } catch (err) {
    Log.d('followState.tapPerson failed', err);
    if (at === epoch) {
      persons.set(userId, was);
      showToast(describeFollowRefusal(refusalCode(err)));
    }
    return null;
  } finally {
    tapping.delete(userId);
    settling.delete(userId);
  }
}

/** The tap on an association's chip: follows at once, goes back on a failure. True once followed. */
export async function tapAssociation(associationId: string): Promise<boolean> {
  if (tapping.has(associationId) || followedAssociations.has(associationId)) return false;
  const at = epoch;
  tapping.add(associationId);
  settling.add(associationId);
  recordAssociationFollowed(associationId, true);
  Log.d('followState.tapAssociation', associationId.slice(0, 8));
  try {
    await followAssociationLedgered(associationId);
    return at === epoch;
  } catch (err) {
    Log.d('followState.tapAssociation failed', err);
    if (at === epoch) {
      recordAssociationFollowed(associationId, false);
      showToast(m.common_generic_error_label());
    }
    return false;
  } finally {
    tapping.delete(associationId);
    settling.delete(associationId);
  }
}
