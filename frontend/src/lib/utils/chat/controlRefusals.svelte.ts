import { SvelteMap, SvelteSet } from 'svelte/reactivity';

/** The user actions that travel as a control event and can be refused by the durable queue. */
export type ControlRefusalKind = 'reaction' | 'edit' | 'pin' | 'delete';

/** One refused control action, with the means to ask the queue again for the SAME act. */
export interface ControlRefusal {
  kind: ControlRefusalKind;
  /**
   * Re-runs the same act (same instants, same payload) against the queue. Resolves true when the
   * queue took it this time, false when it refused again; a non-refusal error rejects.
   */
  retry: () => Promise<boolean>;
}

/**
 * A control action the durable queue REFUSED (`OutboxEnqueueError`), keyed by the message it acts
 * on. The peers will not hear of it, so the message wears a discreet mention with "Retry"
 * (`ControlRefusedNotice`) instead of the refusal living in `console.error` alone.
 *
 * Only the latest refusal per message is kept: the mention names one thing to retry, and a newer
 * act on the same message supersedes an older one (a pin after a failed reaction asks about the pin).
 * Read-watermark refusals are NOT recorded here: they target no message, and the next watermark
 * (or the owed-mark ledger) carries the same information.
 */
const refusals = new SvelteMap<string, ControlRefusal>();
const retrying = new SvelteSet<string>();

/** Records a refusal for `messageId`, replacing any earlier one. */
export function recordControlRefusal(messageId: string, refusal: ControlRefusal): void {
  console.warn(
    `[OUTBOX] control "${refusal.kind}" refused on ${messageId.slice(0, 8)}: notice shown`
  );
  refusals.set(messageId, refusal);
}

/** The refusal shown on `messageId`, or undefined. Reactive. */
export function controlRefusalFor(messageId: string): ControlRefusal | undefined {
  return refusals.get(messageId);
}

/** Forgets the refusal of `messageId` (it was queued meanwhile, or a newer act was queued). */
export function clearControlRefusal(messageId: string): void {
  refusals.delete(messageId);
}

/**
 * Retries the refusal of `messageId`. The mention goes away only once the queue took the act; a
 * second refusal keeps it. Concurrent taps run one retry.
 *
 * @returns true when the act is now queued.
 */
export async function retryControlRefusal(messageId: string): Promise<boolean> {
  const refusal = refusals.get(messageId);
  if (!refusal || retrying.has(messageId)) return false;
  retrying.add(messageId);
  console.log(`[OUTBOX] retrying refused control "${refusal.kind}" on ${messageId.slice(0, 8)}`);
  try {
    const queued = await refusal.retry();
    if (queued && refusals.get(messageId) === refusal) refusals.delete(messageId);
    return queued;
  } finally {
    retrying.delete(messageId);
  }
}
