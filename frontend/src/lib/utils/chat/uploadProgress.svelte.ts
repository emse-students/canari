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
 * - `waiting`: the last attempt failed (or the link is down) and the next one is queued. The bytes
 *   already sent are gone: the media route has no offset, so an attempt always restarts at zero.
 */
export type UploadPhase = 'preparing' | 'uploading' | 'stalled' | 'waiting' | 'blocked' | 'failed';

export interface UploadView {
  phase: UploadPhase;
  /** Bytes of the ENCRYPTED body handed to the network in the current attempt. */
  loaded: number;
  /** Size of that body; 0 until the first progress event says. */
  total: number;
  /** Attempts made so far, so the bubble can say "retry 3" rather than look frozen. */
  attempt: number;
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

/** Drops every view (logout / outbox teardown). */
export function clearAllUploads(): void {
  views.clear();
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
    view.phase === 'waiting' ||
    view.phase === 'blocked' ||
    view.phase === 'failed'
  )
    return null;
  return Math.min(99, Math.floor((view.loaded / view.total) * 100));
}
