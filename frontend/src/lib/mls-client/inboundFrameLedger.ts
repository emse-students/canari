/**
 * Which inbound MLS frames this device has already processed.
 *
 * `SecretReuseError` and `Ciphertext generation out of bounds` say one thing only: the generation
 * this frame was encrypted at has already been consumed. Two very different situations produce it,
 * and until now the client assumed the benign one:
 *
 * - **A real double delivery.** The same frame arrives twice (real-time publish plus the queue or
 *   FCM). The bytes are identical, the message is already displayed, and dropping the second copy
 *   is correct.
 * - **A ratchet rewind.** The sender restored a state behind the one it had already used - across a
 *   reload (WP-LOSS-1) or between two tabs (WP-MULTITAB-1) - and encrypted a NEW message at a
 *   generation we consumed for a DIFFERENT one. The bytes have never been seen here. The message is
 *   cryptographically unrecoverable on this side, and dropping it silently is how a delivered-
 *   looking message is lost.
 *
 * The ledger tells them apart on the only evidence available at that point: the frame's own bytes.
 * A fingerprint of every frame we manage to process is kept, so a later failure can ask "have I
 * seen exactly this frame before?". No, and it is a loss.
 *
 * Answering that question is ALL this module does. It used to also decide what to do about the
 * answer - rate-limiting a retransmission signal, counting episodes, choosing when to escalate to
 * the history diff - and every one of those decisions was a clock. They are gone with the mechanism
 * they served: there is a single repair now, the id-addressed history diff, and the caller reaches
 * for it whenever it is not already reconciling this group (`setupMessageHandler`). A loss is
 * likewise never answered by a local recovery - `onOutOfSync` would destroy a perfectly valid
 * membership to fix nothing.
 *
 * In memory and bounded on purpose. The window that matters is seconds - a double delivery races
 * its own duplicate - and a ledger that survived a reload would have to be persisted on the hot
 * inbound path to buy nothing. The consequence is stated where it is handled: after a reload a
 * genuine duplicate can be reported as a loss, which costs one idempotent retransmission.
 */

/** Frames remembered per group. A double delivery arrives within seconds, never hundreds behind. */
const MAX_FRAMES_PER_GROUP = 200;

const processed = new Map<string, { order: string[]; seen: Set<string> }>();

/**
 * FNV-1a over the frame bytes, plus the length, as hex.
 *
 * Not a cryptographic digest and never treated as one: it is a local, in-memory equality key for
 * bytes this device already holds, it is never transmitted, and a collision costs a dropped
 * retransmission rather than anything a peer could exploit. Synchronous by requirement - this runs
 * on every inbound frame, and `crypto.subtle.digest` is async and would reorder the hot path.
 */
export function frameFingerprint(frame: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < frame.length; i++) {
    hash ^= frame[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${frame.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

/** Records a frame this device has processed, evicting the oldest once the group's ring is full. */
export function noteFrameProcessed(groupId: string, fingerprint: string): void {
  let entry = processed.get(groupId);
  if (!entry) {
    entry = { order: [], seen: new Set() };
    processed.set(groupId, entry);
  }
  if (entry.seen.has(fingerprint)) return;
  entry.seen.add(fingerprint);
  entry.order.push(fingerprint);
  if (entry.order.length > MAX_FRAMES_PER_GROUP) {
    const evicted = entry.order.shift();
    if (evicted !== undefined) entry.seen.delete(evicted);
  }
}

/** True when this exact frame has already been processed in this group, in this session. */
export function hasFrameBeenProcessed(groupId: string, fingerprint: string): boolean {
  return processed.get(groupId)?.seen.has(fingerprint) ?? false;
}

/** Drops everything for a group (leaving it, or forgetting its state). */
export function forgetFrameLedger(groupId: string): void {
  processed.delete(groupId);
}

/** @internal Resets module state between Vitest cases. */
export function resetFrameLedgerForTests(): void {
  processed.clear();
}
