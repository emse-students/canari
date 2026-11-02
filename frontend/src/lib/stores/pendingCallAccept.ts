/**
 * Pending call-accept intent (WP-XP-5).
 *
 * When the user answers an incoming call on the NATIVE ring - the Android ring notification or call
 * screen, or the iOS CallKit UI - the WebRTC/MLS stack is not ready yet: the app may still be locked
 * behind the PIN, and its socket closed. The native answer handler writes `pending_call_accept.json`
 * in the app's private data directory, and this module drains it (`read_and_clear_pending_call_accept`)
 * and holds the intent until the session can act on it.
 *
 * THE NATIVE ANSWER IS CARRIED BY A PRIVATE INTENT, NEVER A PUBLIC URL. The file is written only by
 * the app's own answer handler (on Android, from the answer PendingIntent of a ring this phone is
 * showing, checked against a per-ring nonce); a `fr.emse.canari://` link carries navigation and
 * nothing else, and no parameter of it is read as an answer.
 *
 * THE INTENT IS THE WHOLE ANSWER. It carries every fact joining the call needs - the conversation,
 * the call, video or not, the caller - all of them from the ring the server sent, so the join never
 * waits for the caller's MLS `call_invite`, a transport frame the server delivers only to a device
 * ONLINE when it was sent (calls.md, "An answer from the ring joins on the ring's facts").
 *
 * WHEN IT IS ACTED ON: once the session's socket is up AND its post-connect catch-up is done
 * ({@link setSessionCaughtUp}), whichever of that and the intent comes second.
 */
import { appendLog } from '$lib/utils/sessionLog';
import { isTauriRuntime } from '$lib/utils/openExternal';

export interface PendingCallAccept {
  groupId: string;
  callId: string;
  hasVideo: boolean;
  /** The caller, from the ring push (`callerId`); null when the native side did not name one. */
  callerId: string | null;
  /** Epoch ms when the user answered, stamped by the NATIVE handler at the tap - never on drain. */
  acceptedAt: number;
}

/**
 * An answer older than this is dropped, not joined. It is not what decides a late answer - the
 * server's room token does (`410` once its ring window closed or `ring-end` recorded the ring over)
 * - only a bound on how long a recorded tap may wait for a session before it stops being a tap.
 */
const MAX_PENDING_AGE_MS = 2 * 60_000;

let pending: PendingCallAccept | null = null;
let handler: ((why: string) => void) | null = null;
let caughtUp = false;

/**
 * Registers THE one handler that acts on an intent (`useChatSession`: `answerFromSystemSurface`).
 * A later registration replaces the earlier: there is one session.
 */
export function setPendingCallAcceptHandler(fn: ((why: string) => void) | null): void {
  handler = fn;
}

/** Hands a held intent to the handler when the session is caught up. */
function actIfReady(why: string): void {
  if (!pending || !caughtUp) return;
  if (!handler) {
    appendLog(`[CallAccept] WARN call=${pending.callId} ready (${why}) but no session handles it`);
    return;
  }
  handler(why);
}

/**
 * Records whether the session's socket is up and caught up (`ConnectionDeps.onCaughtUp` sets it,
 * a closed socket clears it). Becoming caught up acts on a held intent.
 */
export function setSessionCaughtUp(value: boolean): void {
  if (caughtUp === value) return;
  caughtUp = value;
  appendLog(`[CallAccept] session caught up=${value}`);
  if (value) actIfReady('the session caught up');
}

/**
 * The end of a post-connect catch-up (`ConnectionDeps.onCaughtUp`). Caught up only if the socket is
 * STILL open: a socket that dropped during the fetch has caught up nothing, and a flag set true then
 * would stay true through the reconnect and act on an intent before that reconnect caught up.
 */
export function markConnectionCaughtUp(socketOpen: boolean): void {
  if (!socketOpen) {
    appendLog(
      '[CallAccept] catch-up ended on a closed socket - not caught up, the next one decides'
    );
  }
  setSessionCaughtUp(socketOpen);
}

/** Records an accept intent drained from the native handler, and acts on it if the session is ready. */
export function setPendingCallAccept(intent: PendingCallAccept): void {
  pending = intent;
  appendLog(
    `[CallAccept] pending accept recorded call=${intent.callId} caller=${intent.callerId ? 'named' : 'unknown'}`
  );
  actIfReady('the answer was recorded');
}

/**
 * Whether an answer from the native ring waits for `callId` - read, not taken. The in-app ring asks
 * before it restarts on the app's return: that return IS the answer's (`utils/callRing.ts`).
 */
export function hasPendingCallAccept(callId: string): boolean {
  return pending?.callId === callId;
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
 * Parses the native accept file. Null - said at error level - when it names no group, no call or
 * no answer instant: a file the native handler did not write whole is not an answer.
 */
export function parsePendingCallAccept(raw: string): PendingCallAccept | null {
  let parsed: Partial<Record<keyof PendingCallAccept, unknown>>;
  try {
    parsed = JSON.parse(raw) as Partial<Record<keyof PendingCallAccept, unknown>>;
  } catch (e) {
    appendLog(`[CallAccept] ERROR the native accept file is not JSON - dropped: ${String(e)}`);
    return null;
  }
  const { groupId, callId, acceptedAt, callerId, hasVideo } = parsed;
  if (typeof groupId !== 'string' || !groupId || typeof callId !== 'string' || !callId) {
    appendLog('[CallAccept] ERROR the native accept file names no group or call - dropped');
    return null;
  }
  if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt)) {
    appendLog(
      `[CallAccept] ERROR the native accept of call=${callId} carries no instant - dropped`
    );
    return null;
  }
  return {
    groupId,
    callId,
    hasVideo: hasVideo === true,
    callerId: typeof callerId === 'string' && callerId ? callerId : null,
    acceptedAt,
  };
}

/**
 * Drains the native accept file (written by the Android or iOS answer handler while the webview may
 * not even be running) into the in-memory intent. Called at startup and on resume; nothing to do
 * outside Tauri or when nothing is pending.
 */
export async function drainNativePendingCallAccept(): Promise<void> {
  // Not a Tauri runtime: no native ring, nothing to drain.
  if (!isTauriRuntime()) return;
  let raw: string | null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    raw = await invoke<string | null>('read_and_clear_pending_call_accept');
  } catch (e) {
    console.error('[CallAccept] the native accept file could not be read:', e);
    return;
  }
  if (!raw) return;
  const intent = parsePendingCallAccept(raw);
  if (intent) setPendingCallAccept(intent);
}

/** The event the native side dispatches when an answer waits in the file. */
export const NATIVE_CALL_ACCEPT_EVENT = 'canari:call-accept';

/**
 * Drains the native accept file whenever the native side says an answer waits
 * ({@link NATIVE_CALL_ACCEPT_EVENT}: iOS `CanariTellPageOfPendingCallAccept` at the CallKit
 * handover, Android `MainActivity.pushCallAccept` on an answer intent). Returns the unsubscribe.
 *
 * WHY AN EVENT: a page iOS launched in the background is already `visible`, and a warm Android
 * activity at the PIN gate stays visible - neither sees the `visibilitychange` the resume drains
 * wait for (calls.md, "The iPhone's answer never joined"). A repeated event is harmless: the drain
 * empties the file, so a second one reads nothing.
 */
export function listenForNativeCallAccept(): () => void {
  const onAccept = () => {
    appendLog('[CallAccept] the native side says an answer waits - draining it');
    void drainNativePendingCallAccept();
  };
  window.addEventListener(NATIVE_CALL_ACCEPT_EVENT, onAccept);
  return () => window.removeEventListener(NATIVE_CALL_ACCEPT_EVENT, onAccept);
}
