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
  /** The other party's user id: its photo is the CallStyle person's icon. Null when there is none. */
  peerUserId: string | null;
  /** The user's own microphone mute: the notification's mute action shows the way back. */
  muted: boolean;
  /**
   * Whether `speaker` is the user's own tap (true) or only the call's default (false). A default
   * loudspeaker yields to a connected headset natively (`pickCallOutput`); a tap does not.
   */
  speakerChosen: boolean;
}

/**
 * WHERE A CALL'S VOICE STARTS: on the loudspeaker for a VIDEO call (the phone is held in front of
 * the face), on the earpiece - or a headset, which the native route prefers when one is connected -
 * for an AUDIO call, held to the ear like a phone call. The owner's first production audio call
 * started on the loudspeaker (`speaker=true` at connecting and live), which no phone dialler does.
 */
export function callStartsOnSpeaker(video: boolean): boolean {
  return video;
}

/**
 * The call's DEFAULT output as the call goes on: {@link callStartsOnSpeaker} once the call holds the
 * microphone (`current` null), then the loudspeaker as soon as video shows - an audio call that turns
 * into a video call is held in front of the face too. Never back to the earpiece when video stops: a
 * voice that jumped to the ear while the phone is on the table would go unheard. A user's own tap
 * always wins over this (`speakerChosen`).
 */
export function nextSpeakerDefault(current: boolean | null, video: boolean): boolean {
  if (current === null) return callStartsOnSpeaker(video);
  return current || video;
}

/** What {@link ongoingCallSpec} describes, besides the state: the page's facts about the call. */
export interface OngoingCallFacts {
  title: string;
  peerUserId: string | null;
  connectedAtMs: number | null;
  speaker: boolean;
  speakerChosen: boolean;
  muted: boolean;
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
  | { kind: 'mute' }
  | { kind: 'foreground' }
  /** The output the service APPLIED: the loudspeaker or not, null when the platform routes. */
  | { kind: 'output'; speaker: boolean | null }
);

/**
 * Reads an event's `detail`. Returns null for anything the Kotlin side does not send - logged by the
 * caller, never guessed at.
 */
export function parseNativeCallEvent(detail: unknown): NativeCallEvent | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as {
    kind?: unknown;
    reason?: unknown;
    code?: unknown;
    callId?: unknown;
    speaker?: unknown;
  };
  if (typeof d.callId !== 'string' || d.callId === '') return null;
  const callId = d.callId;
  const reason = typeof d.reason === 'string' ? d.reason : '';
  switch (d.kind) {
    case 'started':
      return { callId, kind: 'started' };
    case 'hangup':
      return { callId, kind: 'hangup' };
    case 'mute':
      return { callId, kind: 'mute' };
    case 'foreground':
      return { callId, kind: 'foreground' };
    case 'output':
      if (d.speaker !== undefined && typeof d.speaker !== 'boolean') return null;
      return { callId, kind: 'output', speaker: d.speaker ?? null };
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
  facts: OngoingCallFacts
): OngoingCallSpec | null {
  if (!micHeld) return null;
  const { title, peerUserId, connectedAtMs, speaker, speakerChosen, muted } = facts;
  const base = { title, peerUserId, speaker, speakerChosen, muted };
  switch (kind) {
    case 'ringing':
      return { ...base, text: m.call_ringing_label(), connectedAtMs: null };
    case 'connecting':
      return { ...base, text: m.call_connecting_label(), connectedAtMs: null };
    case 'live':
      return { ...base, text: m.call_audio_only_label(), connectedAtMs };
    case 'reconnecting':
      return { ...base, text: m.call_reconnecting(), connectedAtMs };
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

/** What the notification and the service hand back to the call ({@link openAndroidCallSession}). */
export interface AndroidCallHandlers {
  /** The notification's hang-up: the service has already left the foreground, the page ends the call. */
  onHangUp: () => void;
  /**
   * The notification's mute action: the page toggles its microphone, and the next `publish` carries
   * the new `muted`, which redraws the action from the call's own state.
   */
  onMute?: () => void;
  /**
   * Whether the service can route the audio right now: false while a start waits for the app to come
   * back on screen, and once the service is refused or gone for this call - the speaker toggle reads
   * it, so it is never a button that does nothing.
   */
  onRoute?: (available: boolean) => void;
  /**
   * The output the service APPLIED: true on the loudspeaker, false on the earpiece or a headset, null
   * when the platform routes. A loudspeaker DEFAULT yields to a headset natively, so this - not what
   * the page asked - is what the speaker toggle shows.
   */
  onOutput?: (speaker: boolean | null) => void;
}

/** Opens the session for one call. `callId` names this call on the bridge; drawn per session. */
export function openAndroidCallSession(
  host: AndroidCallHost,
  handlers: AndroidCallHandlers,
  callId: string = crypto.randomUUID()
): AndroidCallSession {
  const { onHangUp, onMute = () => {}, onRoute = () => {}, onOutput = () => {} } = handlers;
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
    const facts = `${why}; connected=${spec.connectedAtMs !== null} speaker=${spec.speaker} chosen=${spec.speakerChosen} muted=${spec.muted} peer=${spec.peerUserId !== null}`;
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
      case 'output':
        appendLog(
          `[Call] the service routed the voice to ${event.speaker === null ? 'the platform choice' : event.speaker ? 'the loudspeaker' : 'the earpiece or a headset'}`
        );
        onOutput(event.speaker);
        return;
      case 'mute':
        // The service stays: only the microphone changes, and the next publish redraws the action.
        if (!started) {
          appendLog(
            '[Call] mute from the ongoing-call notification with no service started - ignored'
          );
          return;
        }
        appendLog('[Call] microphone toggled from the ongoing-call notification');
        onMute();
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
