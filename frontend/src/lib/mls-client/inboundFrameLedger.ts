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
 * seen exactly this frame before?". No, and it is a loss - and a loss whose only possible remedy is
 * on the SENDER, which is why the caller signals it rather than triggering a local recovery
 * (`onOutOfSync` would destroy a perfectly valid membership to fix nothing).
 *
 * In memory and bounded on purpose. The window that matters is seconds - a double delivery races
 * its own duplicate - and a ledger that survived a reload would have to be persisted on the hot
 * inbound path to buy nothing. The consequence is stated where it is handled: after a reload a
 * genuine duplicate can be reported as a loss, which costs one idempotent retransmission.
 */

/** Frames remembered per group. A double delivery arrives within seconds, never hundreds behind. */
const MAX_FRAMES_PER_GROUP = 200;

/** One desync signal per group per window: a broken ratchet fails every frame, not just one. */
const SIGNAL_INTERVAL_MS = 30_000;

/**
 * How many signals a group may spend on the narrow repair before it is declared insufficient.
 *
 * Each one asks the peer for a time WINDOW out of an in-memory ring, so it fails for reasons no
 * amount of repetition fixes: the sender reloaded and lost the ring, the payload aged out of it, or
 * the loss is older than the window can reach. Three signals are at least a minute of continuous
 * loss in one group - past that, asking a fourth time is not persistence, it is a loop.
 */
const ESCALATION_SIGNAL_COUNT = 3;

/**
 * Over how long those signals must fall to count as one failing repair.
 *
 * Without it the counter would be cumulative and a group that lost one frame a week would escalate
 * eventually, on evidence that had nothing to do with each other.
 */
const ESCALATION_WINDOW_MS = 5 * 60_000;

const processed = new Map<string, { order: string[]; seen: Set<string> }>();
const lastSignalAt = new Map<string, number>();
const signalTimes = new Map<string, number[]>();

/**
 * What to do about a frame we have just established is LOST rather than duplicated.
 *
 * - `signal` - ask the sender to retransmit the recent window (the narrow repair).
 * - `escalate` - that repair has now failed repeatedly, so stop asking for a window and reach for
 *   the history diff instead: it reads the peer's DURABLE store, is answered by ONE elected member,
 *   and names messages by id rather than by time (WP-HIST-3). The two are exclusive - a signal
 *   already shown not to work is not worth sending alongside its own replacement.
 */
export type DesyncVerdict = { signal: boolean; escalate: boolean };

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

/**
 * Records a detected loss and answers what the caller should do about it.
 *
 * Rate-limited to one verdict per group per {@link SIGNAL_INTERVAL_MS}: a rewound sender does not
 * fail one frame, it fails every frame it sends until its ratchet passes the generations we
 * consumed, and signalling each of them would answer a storm with a storm.
 *
 * The escalation counter deliberately counts SIGNALS, not losses. A repair that works is one whose
 * signal is not followed by more of them, so the thing worth counting is how many times we have
 * asked and still been here - which is also why the count is cleared when it fires: the escalation
 * is a different mechanism, and it must be given its own chance before anything is concluded again.
 */
export function noteDesyncDetected(groupId: string, now: number = Date.now()): DesyncVerdict {
  // A group that has never signalled always may - hence the explicit `undefined`, not a `?? 0`,
  // which would make the answer depend on how far `now` happens to be from the epoch.
  const last = lastSignalAt.get(groupId);
  if (last !== undefined && now - last < SIGNAL_INTERVAL_MS)
    return { signal: false, escalate: false };
  lastSignalAt.set(groupId, now);

  const recent = [...(signalTimes.get(groupId) ?? []), now].filter(
    (t) => now - t < ESCALATION_WINDOW_MS
  );
  if (recent.length >= ESCALATION_SIGNAL_COUNT) {
    signalTimes.delete(groupId);
    return { signal: false, escalate: true };
  }
  signalTimes.set(groupId, recent);
  return { signal: true, escalate: false };
}

/** Drops everything for a group (leaving it, or forgetting its state). */
export function forgetFrameLedger(groupId: string): void {
  processed.delete(groupId);
  lastSignalAt.delete(groupId);
  signalTimes.delete(groupId);
}

/** @internal Resets module state between Vitest cases. */
export function resetFrameLedgerForTests(): void {
  processed.clear();
  lastSignalAt.clear();
  signalTimes.clear();
}
