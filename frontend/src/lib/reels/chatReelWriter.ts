import type { ReelLimits } from '$lib/posts/api';
import type { CaptureDestination } from './reelCapture';

/**
 * THE WRITER OF A CANAREEL IN A CONVERSATION - ON (2026-11-01, after the phone readings of the
 * pull request that flipped it; user, 2026-10-14: never before the resumable upload and the native push).
 *
 * The reader (RC-1) and the server class (RC-2) are in production; this is the one switch that lets a
 * member FILM a reel in a DM or a group. While it is `false` the chat camera takes photos only, as it
 * always did, and nothing below it can run: every other piece of the writer (the declaration, the
 * `chat-reel` upload class) is reached only from a take the camera cannot make. The flip is THIS ONE
 * LINE, and it may land only when all of these hold (reels-in-chat.md section 7):
 *
 * - RC-3's chat encoding profile and 60 s cap wired into the queued take (`chatReelPrepareOptions`,
 *   `captureCapMs`), so a take fits the budget - DONE;
 * - RC-5 shipped (the upload survives a weak network and a kill);
 * - RC-7 shipped (a push says "CanaReel", not "video"), and the readers are the `minClientVersion` floor;
 * - the durable release of a leaked upload session (`uploadReleaseMarks.ts`) - DONE;
 * - and the rest of the section-7 list (re-ordered 2026-10-30), an ordering the OWNER rules on: RC-14
 *   then RC-13, RC-6's `410` amendment, RC-8 or salons kept out.
 *
 * Salons are NOT written by this switch even when it is `true`: their send path is RC-8's.
 */
export const CHAT_REEL_WRITER_ENABLED = true;

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

/**
 * The longest take a CHAT reel may be (D-size, RC-3): the server's `chatMaxDurationMs` (60 s), the
 * one copy, read from `GET /api/posts/reel-limits`. A server that predates RC-3 does not serve it;
 * its general reel cap is then the only cap there is, and that is said as a warning, because it means
 * the server this client talks to is older than the writer it runs.
 */
export function chatReelCapMs(
  limits: Pick<ReelLimits, 'maxDurationMs' | 'chatMaxDurationMs'>
): number {
  if (limits.chatMaxDurationMs === undefined) {
    console.warn(
      `[chat-reel] the server serves no chat cap (older than RC-3): the reel cap ${limits.maxDurationMs} ms applies`
    );
    return limits.maxDurationMs;
  }
  return limits.chatMaxDurationMs;
}

/**
 * The cap the camera arms its ring with for `destination`: the chat cap for a conversation, the reel
 * cap for every other destination (the feed and a post keep `maxDurationMs`, byte-identical to before).
 */
export function captureCapMs(
  limits: Pick<ReelLimits, 'maxDurationMs' | 'chatMaxDurationMs'>,
  destination: CaptureDestination
): number {
  return destination === 'chat' ? chatReelCapMs(limits) : limits.maxDurationMs;
}

/**
 * What the outbox's preparation of a queued chat reel asks of the encoder (RC-3 wired into RC-5): the
 * `chat` profile (540p, 1.2 Mb/s) and the chat cap, so a take filmed under the cap is encoded at the
 * size the retention budget was decided on, and a longer one is refused as a FACT of the take (`too
 * long`, failed for good) rather than uploaded at the feed's size.
 */
export function chatReelPrepareOptions(
  reel: Pick<ReelLimits, 'maxDurationMs' | 'chatMaxDurationMs'>,
  maxPlaintextBytes: number | undefined
): { profile: 'chat'; maxSeconds: number; maxBytes: number | undefined } {
  return { profile: 'chat', maxSeconds: chatReelCapMs(reel) / 1000, maxBytes: maxPlaintextBytes };
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
