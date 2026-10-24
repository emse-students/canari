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
 * declares the service (the main manifest, since the flip of `CALLS_COMPILED`). Outcomes come back as one DOM event, {@link NATIVE_CALL_EVENT}.
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

/**
 * `window.canariCall`, as `CallBridge.JsInterface` defines it. Each method returns at once. `start`
 * and `update` take {@link OngoingCallSpec} plus the `callId` of the call, as JSON.
 */
export interface AndroidCallBridge {
  start(json: string): void;
  update(json: string): void;
  stop(callId: string, reason: string): void;
  pageLoaded(): void;
}

/**
 * Why a start was refused (`CallBridge.CODE_*`): `off-screen` is answered by the next resume (a
 * `foreground` event), `refused` is final for the call.
 */
export type NativeCallRefusal = 'off-screen' | 'refused';

/**
 * What the native side reports, `detail` of {@link NATIVE_CALL_EVENT}. Every event names the call it
 * is about (the id `start` carried), so one of an earlier call that lands late is dropped by a fact.
 */
export type NativeCallEvent = { callId: string } & (
  | { kind: 'started' }
  | { kind: 'failed'; code: NativeCallRefusal; reason: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'hangup' }
  | { kind: 'foreground' }
);

/**
 * Reads an event's `detail`. Returns null for anything the Kotlin side does not send - logged by the
 * caller, never guessed at.
 */
export function parseNativeCallEvent(detail: unknown): NativeCallEvent | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as { kind?: unknown; reason?: unknown; code?: unknown; callId?: unknown };
  if (typeof d.callId !== 'string' || d.callId === '') return null;
  const callId = d.callId;
  const reason = typeof d.reason === 'string' ? d.reason : '';
  switch (d.kind) {
    case 'started':
      return { callId, kind: 'started' };
    case 'hangup':
      return { callId, kind: 'hangup' };
    case 'foreground':
      return { callId, kind: 'foreground' };
    case 'failed':
      if (d.code !== 'off-screen' && d.code !== 'refused') return null;
      return { callId, kind: 'failed', code: d.code, reason };
    case 'stopped':
      return { callId, kind: 'stopped', reason };
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

/**
 * Whether this build has the service - and therefore the audio ROUTE: on Android the speaker toggle
 * is the service's `setCommunicationDevice`, so without the service it would do nothing.
 */
export function hasAndroidCallService(host: AndroidCallHost): boolean {
  return !!host.canariCall;
}

/**
 * Called ONCE per page load on Android. A page that has just loaded holds no call, so a service still
 * in the foreground belongs to the page before it (a reload mid-call, a renderer that crashed and was
 * reloaded): its notification, wake lock and route would outlive the call. Native stops it, and says
 * nothing when none runs - an ordinary boot is silent.
 */
export function releaseCallServiceOfPreviousPage(host: AndroidCallHost): void {
  host.canariCall?.pageLoaded();
}

/** One call's handle on the service. */
export interface AndroidCallSession {
  /** The call's current description; null ends the foreground (the call is over or not ours yet). */
  publish(spec: OngoingCallSpec | null, why: string): void;
  /** The call surface is going: stop the service if it was started, stop listening. */
  dispose(): void;
}

/**
 * Opens the session for one call. `onHangUp` is what the notification's button does: the service has
 * already left the foreground, and the page ends the call. `onRoute` is told whether the service can
 * route the audio right now: false while a start waits for the app to come back on screen, and once
 * the service is refused or gone for this call - the speaker toggle reads it, so it is never a button
 * that does nothing. `callId` names this call on the bridge; drawn per session.
 */
export function openAndroidCallSession(
  host: AndroidCallHost,
  onHangUp: () => void,
  onRoute: (available: boolean) => void = () => {},
  callId: string = crypto.randomUUID()
): AndroidCallSession {
  const bridge = host.canariCall;
  if (!bridge) {
    appendLog(
      '[Call] ERROR this Android build has no ongoing-call service (no canariCall bridge) - the call stops when the app leaves the screen'
    );
    return { publish: () => {}, dispose: () => {} };
  }
  let routeAvailable = true;
  const setRoute = (available: boolean) => {
    if (available === routeAvailable) return;
    routeAvailable = available;
    onRoute(available);
  };
  let started = false;
  /** Set once the service is final for this call (refused, left on its own, hung up): no more asks. */
  let over = false;
  /** A start refused for `off-screen`, not asked again yet: the next `foreground` event asks once. */
  let waitingForeground = false;
  /** The one second ask after an `off-screen` refusal has been spent. */
  let askedAgain = false;
  /** The description last sent, or to send if a `foreground` comes. */
  let current: OngoingCallSpec | null = null;
  let lastSent: string | null = null;

  const send = (spec: OngoingCallSpec, why: string) => {
    const json = JSON.stringify(spec);
    if (json === lastSent) return;
    lastSent = json;
    const payload = JSON.stringify({ ...spec, callId });
    const facts = `${why}; connected=${spec.connectedAtMs !== null} speaker=${spec.speaker}`;
    if (!started) {
      started = true;
      appendLog(`[Call] ongoing-call service start (${facts})`);
      bridge.start(payload);
      return;
    }
    appendLog(`[Call] ongoing-call service update (${facts})`);
    bridge.update(payload);
  };

  const onEvent = (e: Event) => {
    const event = parseNativeCallEvent((e as CustomEvent).detail);
    if (!event) {
      appendLog(
        `[Call] ERROR unreadable ${NATIVE_CALL_EVENT} event: ${JSON.stringify((e as CustomEvent).detail)}`
      );
      return;
    }
    if (event.callId !== callId) {
      // An earlier call's event landing late (its `stopped`, its `hangup`): not this call's.
      appendLog(
        `[Call] ongoing-call event ${event.kind} of another call - not this one's, dropped`
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
        started = false;
        lastSent = null;
        if (event.code === 'off-screen' && !askedAgain) {
          // The app was not resumed at the ask (a dial then an instant HOME, a dialog over it).
          // Native says when it resumes; that EVENT, not a clock, is the one second ask.
          appendLog(
            `[Call] WARN ongoing-call service refused (${event.reason}) - asking once more when the app is back on screen`
          );
          waitingForeground = true;
          setRoute(false);
          return;
        }
        // Final: a second ask in the same call would meet the same state. The call goes on, on
        // screen only, as before this service existed.
        appendLog(
          `[Call] ERROR ongoing-call service refused: ${event.reason} - not asked again for this call`
        );
        waitingForeground = false;
        over = true;
        setRoute(false);
        return;
      case 'foreground':
        if (!waitingForeground || over) return;
        waitingForeground = false;
        askedAgain = true;
        setRoute(true);
        if (current) send(current, 'the app is back on screen');
        return;
      case 'stopped':
        if (started) {
          // Not asked by this page and not a hang-up: the service left on its own.
          appendLog(`[Call] WARN ongoing-call service stopped by Android: ${event.reason}`);
          started = false;
          over = true;
          setRoute(false);
        }
        return;
      case 'hangup':
        // The service has already left the foreground: nothing to stop afterwards.
        started = false;
        over = true;
        appendLog('[Call] hang-up from the ongoing-call notification');
        onHangUp();
        return;
    }
  };
  host.addEventListener(NATIVE_CALL_EVENT, onEvent);

  const stop = (reason: string) => {
    waitingForeground = false;
    if (!started) return;
    started = false;
    lastSent = null;
    appendLog(`[Call] ongoing-call service stop (${reason})`);
    bridge.stop(callId, reason);
  };

  return {
    publish(spec, why) {
      current = spec;
      if (over) return;
      if (!spec) {
        stop(why);
        return;
      }
      if (waitingForeground) return;
      send(spec, why);
    },
    dispose() {
      stop('the call surface closed');
      host.removeEventListener(NATIVE_CALL_EVENT, onEvent);
    },
  };
}
