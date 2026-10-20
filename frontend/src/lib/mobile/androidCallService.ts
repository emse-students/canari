import { m } from '$lib/paraglide/messages';
import type { CallStatusKind } from '$lib/stores/callView.svelte';
import { appendLog } from '$lib/utils/sessionLog';

/**
 * THE CALL, HANDED TO ANDROID'S ONGOING-CALL FOREGROUND SERVICE (WP-C-BG-A).
 *
 * Measured on the Mi 9T (CALL-LOCK-ANDROID, 2026-10-20): locked or sent home, the app lost its call
 * socket and both directions of audio 5 s in, while its JavaScript kept running. A foreground service
 * keeps the process's network and microphone; `CallForegroundService.kt` is that service, and this is
 * the page's side of it: it describes the call ({@link OngoingCallSpec}), starts the service from the
 * gesture that placed or answered the call, updates it when the description changes, stops it when
 * the call ends, and hands the notification's hang-up back to the call.
 *
 * The bridge is `window.canariCall`, registered by `MainActivity` ONLY in a build whose manifest
 * declares the service (`src/calls/AndroidManifest.xml`, merged when `VITE_DEPLOY_ENVIRONMENT` is
 * `development`). Outcomes come back as one DOM event, {@link NATIVE_CALL_EVENT}.
 *
 * Off Android this does nothing BY DESIGN: the browser has no such service and iOS's equivalent is
 * CallKit (WP-C-BG-I). On Android with no bridge, the call works on screen only, and the log says so
 * at error level once per call - the build and the page disagree about whether calls are placed.
 */

/** The DOM event `CallBridge.emit` dispatches. Its twin is `CallBridge.EVENT` in Kotlin. */
export const NATIVE_CALL_EVENT = 'canari:call-native';

/** What the notification and the audio route need. Mirrors `OngoingCallSpec` in `OngoingCall.kt`. */
export interface OngoingCallSpec {
  /** The other party's name: the CallStyle person. */
  title: string;
  /** The status line: a Paraglide word, never the running timer (the chronometer is native). */
  text: string;
  /** Epoch ms of the first `connected`; null until then, and no chronometer is drawn. */
  connectedAtMs: number | null;
  /** The loudspeaker (true) or the earpiece / a headset (false). */
  speaker: boolean;
}

/** `window.canariCall`, as `CallBridge.JsInterface` defines it. Each method returns at once. */
export interface AndroidCallBridge {
  start(json: string): void;
  update(json: string): void;
  stop(reason: string): void;
}

/** What the native side reports, `detail` of {@link NATIVE_CALL_EVENT}. */
export type NativeCallEvent =
  | { kind: 'started' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'hangup' };

/**
 * Reads an event's `detail`. Returns null for anything the Kotlin side does not send - logged by the
 * caller, never guessed at.
 */
export function parseNativeCallEvent(detail: unknown): NativeCallEvent | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as { kind?: unknown; reason?: unknown };
  const reason = typeof d.reason === 'string' ? d.reason : '';
  switch (d.kind) {
    case 'started':
      return { kind: 'started' };
    case 'hangup':
      return { kind: 'hangup' };
    case 'failed':
      return { kind: 'failed', reason };
    case 'stopped':
      return { kind: 'stopped', reason };
    default:
      return null;
  }
}

/**
 * The call's description for the service, or null when there is nothing to hold in the foreground.
 *
 * WHEN IT STARTS is set by two Android rules about a MICROPHONE service: it is started only by an app
 * that is ON SCREEN, and only once `RECORD_AUDIO` is granted. So it starts as soon as the call HOLDS
 * the microphone (`micHeld`: the capture resolved, so the grant exists and its prompt - the first call
 * ever asks - is answered and gone) and the call is the caller's `ringing` or the callee's
 * `connecting`: seconds after the tap that placed or answered it. Waiting for `live` would meet a
 * caller who dialled and pocketed the phone while it rang, and be refused.
 */
export function ongoingCallSpec(
  kind: CallStatusKind,
  micHeld: boolean,
  title: string,
  connectedAtMs: number | null,
  speaker: boolean
): OngoingCallSpec | null {
  if (!micHeld) return null;
  switch (kind) {
    case 'ringing':
      return { title, text: m.call_ringing_label(), connectedAtMs: null, speaker };
    case 'connecting':
      return { title, text: m.call_connecting_label(), connectedAtMs: null, speaker };
    case 'live':
      return { title, text: m.call_audio_only_label(), connectedAtMs, speaker };
    case 'reconnecting':
      return { title, text: m.call_reconnecting(), connectedAtMs, speaker };
    case 'idle':
    case 'incoming':
    case 'ended':
      return null;
  }
}

/** The window as this module reads it, so a test hands in its own. */
export interface AndroidCallHost {
  canariCall?: AndroidCallBridge;
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

/** One call's handle on the service. */
export interface AndroidCallSession {
  /** The call's current description; null ends the foreground (the call is over or not ours yet). */
  publish(spec: OngoingCallSpec | null, why: string): void;
  /** The call surface is going: stop the service if it was started, stop listening. */
  dispose(): void;
}

/**
 * Opens the session for one call. `onHangUp` is what the notification's button does: the page ends
 * the call, and the end then reaches {@link AndroidCallSession.publish} as `null` like any other.
 */
export function openAndroidCallSession(
  host: AndroidCallHost,
  onHangUp: () => void
): AndroidCallSession {
  const bridge = host.canariCall;
  if (!bridge) {
    appendLog(
      '[Call] ERROR this Android build has no ongoing-call service (no canariCall bridge) - the call stops when the app leaves the screen'
    );
    return { publish: () => {}, dispose: () => {} };
  }
  let started = false;
  /** Set once the service refused or left on its own: this call is not retried, it is reported. */
  let over = false;
  let last: string | null = null;

  const onEvent = (e: Event) => {
    const event = parseNativeCallEvent((e as CustomEvent).detail);
    if (!event) {
      appendLog(
        `[Call] ERROR unreadable ${NATIVE_CALL_EVENT} event: ${JSON.stringify((e as CustomEvent).detail)}`
      );
      return;
    }
    switch (event.kind) {
      case 'started':
        appendLog(
          '[Call] ongoing-call service in the foreground - the call survives the app leaving the screen'
        );
        return;
      case 'failed':
        // Not retried: a refusal names a state (not on screen, no microphone grant, a missing
        // declaration) that a second ask in the same call would meet again. The call goes on, on
        // screen only, as before this service existed.
        appendLog(
          `[Call] ERROR ongoing-call service refused: ${event.reason} - not asked again for this call`
        );
        started = false;
        over = true;
        return;
      case 'stopped':
        if (started) {
          // Not asked by this page: the service left on its own (task removed, page gone).
          appendLog(`[Call] WARN ongoing-call service stopped by Android: ${event.reason}`);
          started = false;
          over = true;
        }
        return;
      case 'hangup':
        appendLog('[Call] hang-up from the ongoing-call notification');
        onHangUp();
        return;
    }
  };
  host.addEventListener(NATIVE_CALL_EVENT, onEvent);

  const stop = (reason: string) => {
    if (!started) return;
    started = false;
    last = null;
    appendLog(`[Call] ongoing-call service stop (${reason})`);
    bridge.stop(reason);
  };

  return {
    publish(spec, why) {
      if (over) return;
      if (!spec) {
        stop(why);
        return;
      }
      const json = JSON.stringify(spec);
      if (json === last) return;
      last = json;
      if (!started) {
        started = true;
        appendLog(
          `[Call] ongoing-call service start (${why}; connected=${spec.connectedAtMs !== null} speaker=${spec.speaker})`
        );
        bridge.start(json);
        return;
      }
      appendLog(
        `[Call] ongoing-call service update (${why}; connected=${spec.connectedAtMs !== null} speaker=${spec.speaker})`
      );
      bridge.update(json);
    },
    dispose() {
      stop('the call surface closed');
      host.removeEventListener(NATIVE_CALL_EVENT, onEvent);
    },
  };
}
