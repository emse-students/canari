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
 * WHEN IT IS ACTED ON: AT ONCE - as soon as an intent is held and the session has registered its
 * handler, whichever comes second. The handler shows the call screen straight away and holds only
 * the JOIN until the call's own group is proven current (`services/callGroupCurrent.ts`); it no
 * longer waits for the catch-up of every conversation (owner, 2026-11-28: 10.7 s of a 1.8.2 answer
 * were other conversations' frames - calls.md, "The answer joins on its own group").
 * {@link whenNextCatchUp} is one of the EVENTS that wait re-reads its facts on - never a proof.
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
/** Waiters of {@link whenNextCatchUp}, released the next time the session reads caught up. */
let caughtUpWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

/** The session the catch-up waiters belonged to ended: they are rejected with it. */
export class SessionCatchUpAbandonedError extends Error {
  constructor(reason: string) {
    super(`[CallAccept] the session ended before its next catch-up: ${reason}`);
    this.name = 'SessionCatchUpAbandonedError';
  }
}

/**
 * Registers THE one handler that acts on an intent (`useChatSession`: `answerFromSystemSurface`).
 * A later registration replaces the earlier: there is one session. An intent drained before the
 * handler existed is handed to it now.
 */
export function setPendingCallAcceptHandler(fn: ((why: string) => void) | null): void {
  handler = fn;
  if (fn) actIfReady('the session registered its handler');
}

/** Hands a held intent to the handler, if the session has registered one. */
function actIfReady(why: string): void {
  if (!pending) return;
  if (!handler) {
    // The ordinary order of a cold start that drains before the session exists: the registration
    // hands it over (`setPendingCallAcceptHandler`).
    appendLog(`[CallAccept] call=${pending.callId} held (${why}) until the session registers`);
    return;
  }
  appendLog(
    `[CallAccept] timing: answer handed to the session ${Date.now() - pending.acceptedAt} ms after the native tap (${why})`
  );
  handler(why);
}

/**
 * Records whether the session's socket is up and caught up (`ConnectionDeps.onCaughtUp` sets it,
 * a closed socket clears it). Becoming caught up releases {@link whenNextCatchUp}.
 */
export function setSessionCaughtUp(value: boolean): void {
  if (caughtUp === value) return;
  caughtUp = value;
  appendLog(`[CallAccept] session caught up=${value}`);
  if (!value) return;
  const released = caughtUpWaiters;
  caughtUpWaiters = [];
  for (const { resolve } of released) resolve();
}

/**
 * Resolves at the NEXT time the session reads caught up - never at once, even when it already is:
 * it is an EVENT a wait re-reads its facts on (a connection's catch-up just ended), never a proof
 * of anything (`callGroupCurrent.ts`).
 *
 * @param signal aborting it removes the waiter and rejects with the signal's reason.
 * @throws {SessionCatchUpAbandonedError} (as a rejection) when the session ends first.
 */
export function whenNextCatchUp(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    caughtUpWaiters.push(waiter);
    signal?.addEventListener(
      'abort',
      () => {
        caughtUpWaiters = caughtUpWaiters.filter((w) => w !== waiter);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/**
 * Rejects every {@link whenNextCatchUp} waiter: the session they belong to was signed out, and the
 * next account's catch-up must not wake them. Returns how many there were, for the caller's log.
 */
export function abandonCatchUpWaiters(reason: string): number {
  const abandoned = caughtUpWaiters;
  caughtUpWaiters = [];
  for (const { reject } of abandoned) reject(new SessionCatchUpAbandonedError(reason));
  return abandoned.length;
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

/**
 * Records an accept intent drained from the native handler, and acts on it if the session is ready.
 * An intent of ANOTHER call still held and fresh is never overwritten: refused, said - two answers
 * cannot both be honoured, and the first one tapped is the user's.
 */
export function setPendingCallAccept(intent: PendingCallAccept): void {
  if (
    pending &&
    pending.callId !== intent.callId &&
    Date.now() - pending.acceptedAt <= MAX_PENDING_AGE_MS
  ) {
    appendLog(
      `[CallAccept] WARN accept of call=${intent.callId} refused - the answer of call=${pending.callId} is still pending`
    );
    return;
  }
  pending = intent;
  appendLog(
    `[CallAccept] pending accept recorded call=${intent.callId} caller=${intent.callerId ? 'named' : 'unknown'} ${Date.now() - intent.acceptedAt} ms after the native tap`
  );
  actIfReady('the answer was recorded');
}

/** Drops a pending intent: the account that answered signed out, and the next one never joins it. */
export function clearPendingCallAccept(reason: string): void {
  if (!pending) return;
  appendLog(`[CallAccept] pending accept of call=${pending.callId} dropped - ${reason}`);
  pending = null;
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
