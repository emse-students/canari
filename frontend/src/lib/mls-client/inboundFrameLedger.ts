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
 * How long one episode of loss lasts, for the purpose of not re-soliciting history over and over.
 *
 * The first detection inside this window escalates; the rest do not, because `markAwaitingHistory`
 * is durable and the history mechanism runs its own pending timer from there. Without a window the
 * counter would be cumulative and a group losing one frame a week would look like one episode.
 */
const ESCALATION_WINDOW_MS = 5 * 60_000;

const processed = new Map<string, { order: string[]; seen: Set<string> }>();
const lastSignalAt = new Map<string, number>();
const signalTimes = new Map<string, number[]>();

/**
 * What to do about a frame we have just established is LOST rather than duplicated.
 *
 * - `signal` - ask the sender to retransmit the recent window (the narrow repair).
 * - `escalate` - also reach for the history diff, which reads the peer's DURABLE store, is answered
 *   by ONE elected member, and names messages by id rather than by time (WP-HIST-3).
 *
 * Both are set on the FIRST detection, and that is a measured decision, not a cautious one. The
 * narrow signal has exactly one trigger - this branch, a sender whose ratchet went backwards - and
 * in that situation it asks the sender to re-encrypt at the SAME rewound ratchet, so the
 * retransmission collides exactly as the original did. Measured twice on the browser against
 * production: it fired with 1, then 5, 15 and 25 payloads and delivered none of them, while the
 * history diff repaired the conversation completely (`32 to send, 1 to pull`). It is kept because
 * it costs one control frame and does win the narrow band where the sender has burnt past the
 * receiver's high-water mark by the time the signal lands - but nothing may WAIT on it.
 *
 * Waiting on it is what cost real messages: escalating only after three signals needs 60-90 s of
 * CONTINUOUS loss, and a shallow rewind clears itself before that - by burning generations, partly
 * on those very retransmissions. A 12-generation rewind lost five messages permanently and never
 * escalated; a 60-generation one escalated and healed 16/16. The mechanism that repairs this class
 * must therefore not be gated behind the one that does not.
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
 * Escalation is per EPISODE, not per loss: the first detection inside {@link ESCALATION_WINDOW_MS}
 * asks for the history diff, and the ones that follow do not re-ask. That is not a rate limit for
 * its own sake - `markAwaitingHistory` is durable and the history mechanism re-solicits on its own
 * timer, so a second solicitation would only duplicate work already in flight.
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
  signalTimes.set(groupId, recent);
  return { signal: true, escalate: recent.length === 1 };
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
