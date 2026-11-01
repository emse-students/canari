/**
 * ONE VIDEO ENCODE AT A TIME (reels-in-chat 15.2, RC-13): the CanaReels publish step
 * (`publishReel`) and the outbox's preparation of a chat-reel take (`prepareQueuedChatReel`) each
 * take this lease around their encode. With one file for the feed and the chats (D-onefile) the
 * normal case encodes once; the exception is a publish step that ends without an upload while the
 * take then prepares its own - and two WebCodecs encodes of a 60 s take at once are unmeasured on
 * either phone, each peak already large. So whoever started first holds the lease, and the other
 * waits for its release: an ORDER, never a timer.
 *
 * In memory, per page life: an encode does not survive a reload, and neither does its lease.
 */
import { appendLog } from '$lib/utils/sessionLog';

/** The lease was given up while waiting: the waiter's signal aborted. Typed, never a message. */
export class EncoderLeaseAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super('the wait for the video encoder was abandoned');
    this.name = 'EncoderLeaseAbortedError';
  }
}

interface Waiter {
  holder: string;
  grant: () => void;
}

/** Who holds the encoder now (`null`: free), and who waits for it, first come first served. */
let current: string | null = null;
const waiting: Waiter[] = [];

/** Hands the encoder to the next waiter, or frees it. */
function handOn(): void {
  const next = waiting.shift();
  current = next ? next.holder : null;
  if (next) {
    appendLog(`[ENCODER] lease handed to ${next.holder}`);
    next.grant();
  }
}

/**
 * Waits for the encoder, then holds it until the returned release is called (once; a second call is
 * a no-op). `holder` names the caller in the log ("publish", "take 1a2b3c4d").
 *
 * @throws {EncoderLeaseAbortedError} when `signal` aborts before the lease is granted - the waiter
 *   leaves the line and nothing is held.
 */
export async function acquireEncoderLease(
  holder: string,
  signal?: AbortSignal
): Promise<() => void> {
  if (signal?.aborted) throw new EncoderLeaseAbortedError(signal.reason);
  if (current === null) {
    current = holder;
  } else {
    appendLog(`[ENCODER] ${holder} waits: the encoder is held by ${current}`);
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        holder,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        const at = waiting.indexOf(waiter);
        if (at !== -1) waiting.splice(at, 1);
        appendLog(`[ENCODER] ${holder} stopped waiting for the encoder (aborted)`);
        reject(new EncoderLeaseAbortedError(signal?.reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(waiter);
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    handOn();
  };
}

/** Runs `encode` while holding the encoder lease; the lease is released however it ends. */
export async function withEncoderLease<T>(
  holder: string,
  signal: AbortSignal | undefined,
  encode: () => Promise<T>
): Promise<T> {
  const release = await acquireEncoderLease(holder, signal);
  try {
    return await encode();
  } finally {
    release();
  }
}

/** Who holds the encoder now, for a test or a log line; `null` when it is free. */
export function encoderLeaseHolder(): string | null {
  return current;
}
