/**
 * When this device must tell its siblings that a salon has been read.
 *
 * WHY THIS IS NOT `unreadCount > 0`. A read receipt exists for exactly one reason: another device of
 * mine may be holding a notification banner for this salon, and it has no way of knowing I have just
 * read it. The guard that shipped first asked instead whether THIS device had a non-zero unread
 * counter at the moment the salon was selected - and that counter answers a different question, "do
 * I draw a badge here". The two diverge in the commonest case there is: the salon is already open
 * when the message lands, so it is read live and the counter never rises, so no receipt is ever
 * sent, so the phone in the next room keeps its banner until the app is opened.
 *
 * Reported from a real phone on 2026-08-20, off COMM-21's own run: the runner opens the salon on W1
 * and only then has W2 write into it, which is precisely that case.
 *
 * WHAT IT ASKS INSTEAD is whether a message I did not write, and have not already acknowledged, has
 * now been read here. That is what a sibling's banner is made of. The marker below is the newest
 * such message per salon, so the receipt is sent once per thing there was to read and never again -
 * which is the cost the old guard was protecting against, a silent self-push on every idle open.
 *
 * IN MEMORY ON PURPOSE, and for the same reason the Graine asked-set is: a receipt is a push, and a
 * sibling that was offline never received it. A durable marker would answer "have I ever asked",
 * which is not the question - the next start must be free to signal again.
 */

/** Newest foreign message, per channel conversation id, a receipt has already been sent for. */
const signalled = new Map<string, number>();

/**
 * Whether a receipt is owed for `channelId` now that everything up to `readUpTo` has been read,
 * and records it as owed no more.
 *
 * `readUpTo` is the timestamp of the newest message THIS USER DID NOT WRITE. A caller passing the
 * newest message outright would send one wasted receipt after each of its own sends.
 */
export function claimChannelReadSignal(channelId: string, readUpTo: number): boolean {
  if (!Number.isFinite(readUpTo) || readUpTo <= 0) return false;
  if ((signalled.get(channelId) ?? 0) >= readUpTo) return false;
  signalled.set(channelId, readUpTo);
  return true;
}

/** The newest message in `messages` that `userId` did not write, as a timestamp, or 0 if there is none. */
export function newestForeignMessageAt(
  messages: readonly { senderId: string; timestamp: Date }[],
  userId: string
): number {
  const mine = userId.toLowerCase();
  // Backwards: the newest foreign message is near the end of an ordered list, and on a long salon
  // scanning the whole history to find it would be work every selection pays.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.senderId.toLowerCase() !== mine) return m.timestamp.getTime();
  }
  return 0;
}

/** Forgets every marker. Called when the session ends, and by tests. */
export function resetChannelReadSignals(): void {
  signalled.clear();
}
