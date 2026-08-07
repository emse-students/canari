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

/**
 * How far back a peer may ask us to look when it reports a frame it could not decrypt.
 *
 * It cannot name the message - the frame never decrypted, so its id was never seen - so the request
 * is a WINDOW. Wide enough to cover the rewind that produced the loss (a reload plus the send that
 * follows it, or a switch between two tabs); short enough that the answer stays a handful of
 * payloads. This is the receiver's half of the contract, kept here beside the sender's half so the
 * two cannot drift: a window wider than the retention below asks for what nobody kept.
 */
export const DESYNC_RETRANSMIT_WINDOW_MS = 120_000;

/**
 * Slack between the window a peer may ask for and how long we actually keep a payload.
 *
 * The peer measures its window from the moment it NOTICES, and its signal then has to reach us: a
 * frame sent at the very edge of the window is requested a round trip later. Retaining exactly the
 * window would drop precisely the oldest payload every request asks about.
 */
const RETRANSMIT_ROUND_TRIP_MARGIN_MS = 30_000;

/**
 * Older than this and a retransmission is no longer worth the bytes.
 *
 * DERIVED, not chosen: the replay is clamped to what is asked, so retaining beyond the widest
 * question a peer can pose shortens nothing and only holds plaintext protos in memory for longer.
 * It was a flat five minutes, of which three could never be requested by anyone.
 */
const RETENTION_MS = DESYNC_RETRANSMIT_WINDOW_MS + RETRANSMIT_ROUND_TRIP_MARGIN_MS;

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
