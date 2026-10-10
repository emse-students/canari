import { SvelteSet } from 'svelte/reactivity';

/**
 * WHAT THE OUTBOX IS DOING RIGHT NOW, as known facts the UI can react to (never a timer).
 *
 * `handleSendChat` writes the optimistic placeholder (`mediaId ''`) BEFORE the durable INSERT, and
 * the INSERT of a large attachment takes seconds. In that window the outbox honestly answers
 * "absent", which the bubble's orphan check read as an orphan: a red card whose Delete would
 * withdraw a healthy upload. The sender KNOWS the enqueue is in flight, so it says so here.
 */
const inflight = new SvelteSet<string>();
let version = $state(0);

/**
 * Mark `messageId` as being enqueued. Returns the function that ends it - call it in a `finally`,
 * so a rejected enqueue clears the mark too. Ending bumps {@link outboxQueueVersion}, because the
 * row has just landed (or been withdrawn) and any earlier "absent" answer is stale.
 */
export function beginOutboxEnqueue(messageId: string): () => void {
  inflight.add(messageId);
  return () => {
    inflight.delete(messageId);
    bumpOutboxQueueVersion();
  };
}

/** Whether `messageId` is between its placeholder write and the end of its durable enqueue. */
export function isOutboxEnqueueInflight(messageId: string): boolean {
  return inflight.has(messageId);
}

/** Reactive counter of queue changes (enqueue settled, entry cancelled): re-ask the outbox on a change. */
export function outboxQueueVersion(): number {
  return version;
}

/** Signal that the durable queue changed. */
export function bumpOutboxQueueVersion(): void {
  version++;
}
