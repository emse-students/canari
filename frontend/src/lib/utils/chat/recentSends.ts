/**
 * What this device has sent recently, kept so it can send it again on request.
 *
 * A peer whose ratchet we rewound cannot decrypt what we sent - not now, not later, not from
 * history: the generation is spent and no local recovery on its side can undo that. The only party
 * able to fix it is us, the sender, by encrypting the same payload again at a generation the peer
 * has not consumed. That requires having kept the payload, which the outbox does not do: an entry
 * is deleted the moment it is sent.
 *
 * So the exact proto bytes handed to MLS are kept here for a few minutes. Retransmitting them is
 * safe to do speculatively: the receiver deduplicates on the stable `messageId` carried INSIDE the
 * proto, so a message that did arrive is dropped on the second copy, and one that did not is
 * recovered. That is what makes it acceptable to answer a signal whose precision is only "something
 * from you, around this time, did not decrypt" - see `decrypt_failed` in `systemMessageHandler.ts`.
 *
 * In memory, so a reload loses it and the retransmission is simply not possible; the caller logs
 * that rather than pretending otherwise.
 */

/** A payload already sent, retained for possible retransmission. */
export interface RecentSend {
  messageId: string;
  /** The exact AppMessage proto handed to `mlsService.sendMessage`. */
  proto: Uint8Array;
  sentAt: number;
}

/** Retained per conversation. A rewind loses a handful of messages, never dozens. */
const MAX_PER_CONVERSATION = 25;

/** Older than this and a retransmission is no longer worth the bytes. */
const RETENTION_MS = 5 * 60_000;

const recent = new Map<string, RecentSend[]>();

/** Records a payload just sent, evicting by age and then by count. */
export function noteSentFrame(
  conversationId: string,
  messageId: string,
  proto: Uint8Array,
  sentAt: number = Date.now()
): void {
  const list = recent.get(conversationId) ?? [];
  const cutoff = Date.now() - RETENTION_MS;
  const kept = list.filter((s) => s.sentAt >= cutoff && s.messageId !== messageId);
  kept.push({ messageId, proto, sentAt });
  recent.set(conversationId, kept.slice(-MAX_PER_CONVERSATION));
}

/** The payloads sent in this conversation at or after `since`, oldest first. */
export function recentSentSince(conversationId: string, since: number): RecentSend[] {
  const cutoff = Date.now() - RETENTION_MS;
  return (recent.get(conversationId) ?? [])
    .filter((s) => s.sentAt >= since && s.sentAt >= cutoff)
    .sort((a, b) => a.sentAt - b.sentAt);
}

/** Drops everything retained for a conversation (leaving it, or logging out). */
export function forgetRecentSends(conversationId: string): void {
  recent.delete(conversationId);
}

/** @internal Resets module state between Vitest cases. */
export function resetRecentSendsForTests(): void {
  recent.clear();
}
