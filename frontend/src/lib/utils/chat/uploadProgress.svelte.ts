/**
 * What a queued attachment's bubble knows about its upload, by message id (offline-and-weak-network,
 * WP-OFF-8).
 *
 * WHY A STORE BESIDE THE OUTBOX AND NOT A FIELD ON THE MESSAGE. The numbers change several times a
 * second and mean nothing after the send: persisting them in the message row would write IndexedDB
 * at the pace of a progress event, and a row reloaded after a crash would show a percentage nobody
 * is advancing. They live in memory, are born when an upload starts and die when the entry leaves
 * the queue, so a reload shows the honest state - "waiting" - until the flush runs again.
 *
 * The OUTBOX is the only writer (it owns the upload and its lifecycle); the bubble only reads. Its
 * cancel is the ordinary delete of an unsent message (`deleteMessage` withdraws the entry, and the
 * outbox aborts the transfer when it does); its retry goes back through {@link setUploadRetry},
 * registered by the outbox, so the component never imports the queue.
 */

import { SvelteMap } from 'svelte/reactivity';

/**
 * - `preparing`: the file is being read and encrypted on this device, no byte has left yet.
 * - `uploading`: bytes are leaving; `loaded`/`total` are real.
 * - `stalled`: bytes were leaving and none has moved for a while (the guard will abandon it).
 * - `blocked`: the gateway refused the request (a time-limited ban). Nothing is retried on its own;
 *   the member retries or deletes.
 * - `failed`: the last attempts each ended with no answer at all while online (the server, or a relay in
 *   front of it, never replied). Terminal until the member retries or deletes; nothing runs on its own.
 *   On a TEXT (no upload at all) it is the one view the outbox writes: the server answered 5xx
 *   `MAX_CONSECUTIVE_SERVER_ERRORS` times in a row, and the bubble offers its Retry from it.
 * - `error`: the attempts kept failing for a reason that is not the network (an unreadable file, an
 *   unexpected error) - terminal until the member retries or deletes; nothing runs on its own.
 * - `queued`: the entry is in the queue and has not started (its turn has not come, or the file is
 *   about to be read). A statement about the queue only, never about the network.
 * - `waiting`: the last attempt ended with NO ANSWER (a transport failure) or the link is known to be
 *   down, and the next one is queued. The bytes already sent are gone: the media route has no offset,
 *   so an attempt always restarts at zero - EXCEPT a chat reel, whose resumable session (RC-5) sends
 *   only the parts the server does not hold.
 * - `repairing`: the entry is held until the conversation's group is sendable again (roster repair,
 *   re-add requested); the connection is fine.
 * - `retrying`: the last attempt failed for another reason (a server error, a local one) and the
 *   next is scheduled on the backoff ladder.
 */
export type UploadPhase =
  | 'preparing'
  | 'uploading'
  | 'stalled'
  | 'queued'
  | 'waiting'
  | 'repairing'
  | 'retrying'
  | 'blocked'
  | 'failed'
  | 'error';

export interface UploadView {
  phase: UploadPhase;
  /** Bytes of the ENCRYPTED body handed to the network in the current attempt. */
  loaded: number;
  /** Size of that body; 0 until the first progress event says. */
  total: number;
  /** Attempts made so far, so the bubble can say "retry 3" rather than look frozen. */
  attempt: number;
  /**
   * How far the on-device PREPARATION has got (0-1), for an entry that owes one (a chat reel's
   * re-encode, reels-in-chat RC-5). Absent for every other attachment, whose `preparing` is short.
   */
  prepared?: number;
}

/** Whole percent of a running preparation, clamped to 0-99; `null` when none is measured. */
export function preparePercent(view: UploadView): number | null {
  if (view.phase !== 'preparing' || view.prepared === undefined) return null;
  return Math.min(99, Math.max(0, Math.floor(view.prepared * 100)));
}

const views = new SvelteMap<string, UploadView>();
let retryHandler: ((messageId: string) => void) | null = null;

/** Reactive read: the bubble of `messageId` re-renders as its entry's progress moves. */
export function uploadViewOf(messageId: string): UploadView | undefined {
  return views.get(messageId);
}

/** Merge a change into the view of `messageId`, creating it as `preparing` when it is the first. */
export function patchUpload(messageId: string, patch: Partial<UploadView>): void {
  const prev = views.get(messageId) ?? { phase: 'preparing', loaded: 0, total: 0, attempt: 0 };
  views.set(messageId, { ...prev, ...patch });
}

/** The entry left the queue (sent, withdrawn, failed for good): nothing left to show. */
export function clearUpload(messageId: string): void {
  views.delete(messageId);
}

/**
 * Why an attachment the outbox retired for good was never sent, when the cause is the GROUP rather
 * than the file (review of #2874, M4): the conversation was deleted, or this device is no longer a
 * member of it (evicted, or a re-admission whose Welcome never came). Without it the bubble said
 * "refused by the server", which is the file's failure, not this one.
 */
export type UnsentReason = 'group-deleted' | 'not-a-member';

const unsentReasons = new SvelteMap<string, UnsentReason>();

/** Reactive read of {@link UnsentReason} for `messageId`; undefined when the outbox gave none. */
export function unsentReasonOf(messageId: string): UnsentReason | undefined {
  return unsentReasons.get(messageId);
}

/** The outbox, retiring an attachment for a reason that is the group's. */
export function setUnsentReason(messageId: string, reason: UnsentReason): void {
  unsentReasons.set(messageId, reason);
}

/** Drops every view and every reason (logout / outbox teardown). */
export function clearAllUploads(): void {
  views.clear();
  unsentReasons.clear();
}

/**
 * The outbox registers what "retry now" does (try again skipping the backoff, abandoning a stalled
 * attempt); `null` on teardown.
 */
export function setUploadRetry(next: ((messageId: string) => void) | null): void {
  retryHandler = next;
}

/** Retry from a bubble. A no-op without a registered outbox (logged out). */
export function retryUpload(messageId: string): void {
  retryHandler?.(messageId);
}

/**
 * Whole percent of the body sent, clamped to 0-99 while the upload is open: 100 is the SERVER'S
 * answer, not the last byte leaving, so a bar parked at "100 %" would be a lie for the seconds the
 * media service takes to assemble and store the object. `null` when no honest figure exists.
 */
export function uploadPercent(view: UploadView): number | null {
  if (
    view.total <= 0 ||
    view.phase === 'preparing' ||
    view.phase === 'queued' ||
    view.phase === 'waiting' ||
    view.phase === 'repairing' ||
    view.phase === 'retrying' ||
    view.phase === 'blocked' ||
    view.phase === 'failed' ||
    view.phase === 'error'
  )
    return null;
  return Math.min(99, Math.floor((view.loaded / view.total) * 100));
}
