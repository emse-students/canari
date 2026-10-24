/**
 * THE WRITER OF A CANAREEL IN A CONVERSATION - `false` UNTIL RC-5 AND RC-7 HAVE SHIPPED (user,
 * 2026-10-14: the writer waits for the resumable upload and the native push before ANY stable).
 *
 * The reader (RC-1) and the server class (RC-2) are in production; this is the one switch that lets a
 * member FILM a reel in a DM or a group. While it is `false` the chat camera takes photos only, as it
 * always did, and nothing below it can run: every other piece of the writer (the declaration, the
 * `chat-reel` upload class) is reached only from a take the camera cannot make. The flip is THIS ONE
 * LINE, and it may land only when all of these hold (reels-in-chat.md section 7):
 *
 * - RC-3 shipped (the chat encoding profile and the 60 s cap), so a take fits the budget;
 * - RC-5 shipped (the upload survives a weak network and a kill);
 * - RC-7 shipped (a push says "CanaReel", not "video"), and the readers are the `minClientVersion` floor.
 *
 * Salons are NOT written by this switch even when it is `true`: their send path is RC-8's.
 */
export const CHAT_REEL_WRITER_ENABLED = false;

/** A chat reel's life, the server's window (`CHAT_REEL_RETENTION_DAYS` in media-service). */
export const CHAT_REEL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What the sender declares for a reel message: the three fields `MediaMsg` carries for it. */
export interface ChatReelDeclaration {
  intent: 'reel-message';
  durationMs: number;
  /** A display hint (the server sweeps on its own clock and answers 410). */
  expiresAtMs: number;
}

/**
 * The declaration of a RAW take queued now (RC-5): the intent and the expiry hint, and no length -
 * the outbox's preparation measures it and adds `durationMs` (whole ms, floored at 1: a zero is "no
 * length" on the wire) before the message is built. The clock is passed in so no test asserts a
 * wall clock.
 */
export function chatReelPendingDeclaration(
  nowMs: number
): Pick<ChatReelDeclaration, 'intent' | 'expiresAtMs'> {
  return { intent: 'reel-message', expiresAtMs: nowMs + CHAT_REEL_RETENTION_MS };
}

/**
 * Whether a take from the chat camera may be a video: the switch is on AND the conversation is one
 * this package writes (a DM or a group - never a salon).
 */
export function chatReelAllowed(
  isChannel: boolean,
  writerEnabled = CHAT_REEL_WRITER_ENABLED
): boolean {
  return writerEnabled && !isChannel;
}

/**
 * The retention class an outbox attachment is uploaded as: a declared reel is `chat-reel` (swept by
 * AGE, counted against the member's daily budget), everything else `ephemeral` as before. Naming
 * `chat-reel` can only SHORTEN an object's life, which is why the client may say it.
 */
export function uploadClassFor(media: { intent?: 'reel-message' }): 'chat-reel' | 'ephemeral' {
  return media.intent === 'reel-message' ? 'chat-reel' : 'ephemeral';
}

/** The files the chat camera filmed as a reel message, keyed by the file like `capturePoster.ts`. */
const reelTakes = new WeakSet<File>();

/** Marks `file` as a take of the chat camera that the member means as a reel message. */
export function markChatReelTake(file: File): void {
  console.debug(`[chat-reel] ${file.name}: marked as a reel message`);
  reelTakes.add(file);
}

/** Whether the chat camera filmed `file` as a reel message. */
export function isChatReelTake(file: File): boolean {
  return reelTakes.has(file);
}
