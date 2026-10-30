/**
 * Pending call-accept intent (WP-XP-5).
 *
 * When the user answers an incoming call from a SYSTEM surface - the Android ring (deep link
 * `?acceptCall=`) or the iOS CallKit UI (native `pending_call_accept.json`, drained via the
 * `read_and_clear_pending_call_accept` Tauri command) - the WebRTC/MLS stack is not ready yet: the
 * app may still be locked behind the PIN, and its socket closed. This module holds that intent until
 * the session can act on it, and tells the one listener (`useChatSession`) when one is recorded.
 *
 * THE INTENT IS THE WHOLE ANSWER. It carries every fact joining the call needs - the conversation,
 * the call, video or not, the caller - all of them from the ring the server sent, so the join never
 * waits for the caller's MLS `call_invite`. That invite is a transport frame the server delivers only
 * to a device ONLINE when it was sent (`TRANSPORT_SKIPPED_OFFLINE`), and a phone rung while closed
 * was not: waiting for it is what left every answer from a closed phone unanswered (1.5.2-alpha.1,
 * calls.md "An answer from the ring joins on the ring's facts").
 */
import { appendLog } from '$lib/utils/sessionLog';

export interface PendingCallAccept {
  groupId: string;
  callId: string;
  hasVideo: boolean;
  /** The caller, from the ring push (`callerId`); null when the native side predates the field. */
  callerId: string | null;
  /** Epoch ms when the user answered; stale intents are dropped (call long gone). */
  acceptedAt: number;
}

/**
 * An answer older than this is not acted on. Not what decides a late answer - the server's room
 * token does (`410` once its ring window closed) - only a bound on how long a recorded tap may wait
 * for a session before it is dropped rather than joined into a different moment.
 */
const MAX_PENDING_AGE_MS = 2 * 60_000;

let pending: PendingCallAccept | null = null;
let listener: (() => void) | null = null;

/**
 * Registers THE one listener told when an intent is recorded (`useChatSession`, which answers it
 * once its socket is up). A later registration replaces the earlier: there is one session.
 */
export function setPendingCallAcceptListener(fn: (() => void) | null): void {
  listener = fn;
}

/** Records an accept intent (from a deep link or the native CallKit handler) and tells the session. */
export function setPendingCallAccept(intent: PendingCallAccept): void {
  pending = intent;
  appendLog(
    `[CallAccept] pending accept recorded call=${intent.callId} caller=${intent.callerId ? 'named' : 'unknown'}`
  );
  listener?.();
}

/**
 * Takes the pending intent, if one is fresh. Leaves nothing behind either way: an intent is acted on
 * once, and an expired one is dropped, said.
 */
export function takePendingCallAccept(): PendingCallAccept | null {
  if (!pending) return null;
  const intent = pending;
  pending = null;
  if (Date.now() - intent.acceptedAt > MAX_PENDING_AGE_MS) {
    appendLog(`[CallAccept] pending accept of call=${intent.callId} expired - dropped`);
    return null;
  }
  return intent;
}

/**
 * Drains the native iOS CallKit accept file (written by `performAnswerCallAction` while the
 * webview may not even be running) into the in-memory intent. Call at startup and on resume;
 * no-op outside Tauri or when nothing is pending.
 */
export async function drainNativePendingCallAccept(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<string | null>('read_and_clear_pending_call_accept');
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PendingCallAccept>;
    if (!parsed.groupId || !parsed.callId) {
      appendLog('[CallAccept] ERROR the native accept file names no group or call - dropped');
      return;
    }
    setPendingCallAccept({
      groupId: parsed.groupId,
      callId: parsed.callId,
      hasVideo: !!parsed.hasVideo,
      callerId: typeof parsed.callerId === 'string' && parsed.callerId ? parsed.callerId : null,
      acceptedAt: typeof parsed.acceptedAt === 'number' ? parsed.acceptedAt : Date.now(),
    });
  } catch {
    // Non-Tauri runtime or malformed file: nothing to drain.
  }
}
