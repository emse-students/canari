import { appendLog } from '$lib/utils/sessionLog';

/**
 * The call, told to the OPERATING SYSTEM through the Media Session API - the web-safe half of "a
 * call keeps going when the app is not in front".
 *
 * What it buys, where the engine has it: a title on the system's media surface (the caller's name),
 * and the `hangup` / `togglemicrophone` actions Chromium wires to its call controls (the document
 * Picture-in-Picture window, hardware headset keys on some platforms). It does NOT keep a hidden page
 * alive, keep the microphone open in the background, or draw an ongoing-call notification - those are
 * native (an Android foreground service of type `phoneCall`, an iOS CallKit call); see
 * `docs/wiki/frontend/modules/calls.md#the-call-in-the-background`.
 *
 * Every action is set in its own `try`: an engine that does not know an action THROWS on
 * `setActionHandler`, and one unknown action must not cost the others. Each refusal is logged once
 * per page life, because "the system has no hang-up for this call" is exactly what a device reading needs.
 */

/** What the call surface hands the OS. */
export interface CallMediaSessionParams {
  title: string;
  artist: string;
  muted: boolean;
  onHangup: () => void;
  onToggleMicrophone: () => void;
}

type CallAction = 'hangup' | 'togglemicrophone';

/** The subset of `navigator` this touches, so a test can hand in its own. */
export interface MediaSessionHost {
  mediaSession?: MediaSession;
}

/**
 * The refusals already said, by key, FOR THE LIFE OF THE PAGE. A refusal is a fact about the ENGINE
 * (WebKit has no `hangup` action, Chromium has), and the Media Session API offers no way to ask for
 * support up front - `setActionHandler` throwing IS the probe - so it is said once: the surface
 * re-applies the session on every change it shows (313 identical lines in 46 s of a ring,
 * 2026-10-31), and each later call of the same page would only repeat it (once per call on the
 * iPhone 12, 2026-10-30).
 */
const saidThisEngine = new Set<string>();

/** Logs `line` once per page life under `key`. */
function sayOncePerEngine(key: string, line: string): void {
  if (saidThisEngine.has(key)) return;
  saidThisEngine.add(key);
  appendLog(line);
}

/** Test seam: forgets what was said, as a fresh page load would. */
export function resetCallMediaSessionForTest(): void {
  saidThisEngine.clear();
}

/** Publishes the call to the OS media session. Returns whether the engine has one at all. */
export function applyCallMediaSession(
  host: MediaSessionHost,
  params: CallMediaSessionParams
): boolean {
  const session = host.mediaSession;
  if (!session) {
    sayOncePerEngine(
      'no-api',
      '[Call] no Media Session API on this engine - the OS shows no call controls'
    );
    return false;
  }
  try {
    if (typeof MediaMetadata !== 'undefined') {
      session.metadata = new MediaMetadata({ title: params.title, artist: params.artist });
    }
    session.playbackState = 'playing';
  } catch (e) {
    appendLog(`[Call] Media Session metadata refused: ${String(e)}`);
  }
  const handlers: Record<CallAction, () => void> = {
    hangup: params.onHangup,
    togglemicrophone: params.onToggleMicrophone,
  };
  for (const [action, handler] of Object.entries(handlers) as [CallAction, () => void][]) {
    try {
      session.setActionHandler(action as MediaSessionAction, handler);
    } catch (e) {
      sayOncePerEngine(
        `action:${action}`,
        `[Call] Media Session action '${action}' unsupported here: ${String(e)}`
      );
    }
  }
  // Chromium only: lets the system's own microphone indicator follow the in-app mute.
  const withMic = session as MediaSession & { setMicrophoneActive?: (active: boolean) => void };
  try {
    withMic.setMicrophoneActive?.(!params.muted);
  } catch (e) {
    appendLog(`[Call] Media Session setMicrophoneActive refused: ${String(e)}`);
  }
  return true;
}

/** Takes the call off the OS media session (the call ended or the surface unmounted). */
export function clearCallMediaSession(host: MediaSessionHost): void {
  const session = host.mediaSession;
  if (!session) return;
  for (const action of ['hangup', 'togglemicrophone'] as CallAction[]) {
    try {
      session.setActionHandler(action as MediaSessionAction, null);
    } catch {
      // Unsupported on this engine: applyCallMediaSession already said so.
    }
  }
  try {
    session.metadata = null;
    session.playbackState = 'none';
  } catch (e) {
    appendLog(`[Call] Media Session reset refused: ${String(e)}`);
  }
}
