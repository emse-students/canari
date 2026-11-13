import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * WHICH WAY THE APP MAY TURN: portrait everywhere, rotation on the video and camera screens only
 * (owner, 2026-11-09). Design, per platform: docs/wiki/frontend/screen-orientation.md.
 *
 * - `portrait`: the app's default, upright only.
 * - `auto`: follows the accelerometer AND the phone's rotation lock (Android `SCREEN_ORIENTATION_USER`,
 *   iOS's own auto-rotation, which the lock already stops).
 * - `landscape`: the rotate button - landscape even with the lock on (YouTube's full-screen button).
 * - `locked`: whatever is on screen NOW, and nothing else - not the other landscape side, and on a
 *   tablet too (where `portrait` and `auto` leave the turn free). A take and a live on air hold it.
 *
 * OWNERSHIP IS A STACK OF REQUESTS, AND AN UNMOUNT IS THE ONLY WAY BACK. A screen requests a mode while
 * it is mounted ({@link requestOrientation} / {@link useScreenOrientation}) and releases it when it
 * unmounts; the effective mode is the NEWEST live request's, `portrait` when there is none. A viewer
 * opened over the camera wins while it is open, and its release hands the turn back to the camera.
 * No timer and no guess: the mode changes only when a request is made, changed or released.
 *
 * Native receives the mode through `window.canariOrientation.set` (Android, `MainActivity`) or
 * `webkit.messageHandlers.canariOrientation` (iOS, `canari_ios.mm`). The WEB build has nothing to
 * ask: a browser tab turns with the phone, and `screen.orientation.lock` exists only in fullscreen, so
 * there {@link orientationCanBeForced} is false and the rotate button is not drawn.
 */
export type OrientationMode = 'portrait' | 'auto' | 'landscape' | 'locked';

/** One screen's ask, held while it is mounted. */
export interface OrientationRequest {
  /** The mode this request currently asks for. */
  readonly mode: OrientationMode;
  /** Changes this request's mode (the rotate button). A released request ignores it. */
  set(mode: OrientationMode): void;
  /** Withdraws the request; the next live one (or portrait) takes over. Idempotent. */
  release(): void;
}

interface Entry {
  id: number;
  owner: string;
  mode: OrientationMode;
}

/** `window.canariOrientation`, registered by `MainActivity.onWebViewCreate`. */
interface AndroidOrientationBridge {
  set(mode: string): void;
}

/** `webkit.messageHandlers.canariOrientation`, registered by `canari_ios.mm`. */
interface IosOrientationHandler {
  postMessage(mode: string): void;
}

const requests: Entry[] = [];
let nextId = 1;
/** The mode native last received; null until the boot's `portrait`, so the first post always goes. */
let posted: OrientationMode | null = null;
/** An absent bridge is said once, not once per screen. */
let absenceSaid = false;

/** What the viewport is right now, read from `(orientation: landscape)`. Reactive. */
class ViewportOrientation {
  landscape = $state(false);
}
export const viewportOrientation = new ViewportOrientation();

function androidBridge(): AndroidOrientationBridge | undefined {
  return (window as Window & { canariOrientation?: AndroidOrientationBridge }).canariOrientation;
}

function iosHandler(): IosOrientationHandler | undefined {
  return (
    globalThis as unknown as {
      webkit?: { messageHandlers?: { canariOrientation?: IosOrientationHandler } };
    }
  ).webkit?.messageHandlers?.canariOrientation;
}

/**
 * Whether this build can turn the screen on a request: the native app with its bridge. The web build
 * cannot (no lock outside fullscreen), so the rotate button is not drawn there.
 */
export function orientationCanBeForced(): boolean {
  if (typeof window === 'undefined') return false;
  if (isAndroidTauriRuntime()) return androidBridge() !== undefined;
  if (isIosTauriRuntime()) return iosHandler() !== undefined;
  return false;
}

/** Hands `mode` to native. False when this is not the native app (nothing to tell). */
function sendToNative(mode: OrientationMode): boolean {
  const android = isAndroidTauriRuntime();
  const ios = isIosTauriRuntime();
  if (!android && !ios) return false;
  try {
    if (android) {
      const bridge = androidBridge();
      if (bridge) {
        bridge.set(mode);
        return true;
      }
    } else {
      const handler = iosHandler();
      if (handler) {
        handler.postMessage(mode);
        return true;
      }
    }
  } catch (e) {
    console.error(`[ORIENTATION] native refused the mode ${mode}:`, e);
    return true;
  }
  // Only an ASK that cannot be honoured is a defect; staying portrait with no bridge is not.
  if (mode !== 'portrait' && !absenceSaid) {
    absenceSaid = true;
    console.error(
      '[ORIENTATION] the canariOrientation bridge is absent from this build - the screen stays portrait'
    );
  }
  return true;
}

/** Posts the effective mode when it changed; one line per change, naming why. */
function apply(why: string): void {
  const mode = requests.at(-1)?.mode ?? 'portrait';
  if (posted === mode) return;
  const previous = posted;
  posted = mode;
  if (sendToNative(mode)) Log.i('ORIENTATION', `${previous ?? 'boot'} -> ${mode} (${why})`);
}

/**
 * Requests `mode` for `owner` (a short screen name, for the log) until {@link OrientationRequest.release}.
 * The newest live request decides.
 */
export function requestOrientation(mode: OrientationMode, owner: string): OrientationRequest {
  const entry: Entry = { id: nextId++, owner, mode };
  requests.push(entry);
  Log.d('ORIENTATION', `request ${entry.id} ${owner}: ${mode}`);
  apply(`${owner} asked`);
  let released = false;
  return {
    get mode() {
      return entry.mode;
    },
    set(next: OrientationMode) {
      if (released || entry.mode === next) return;
      entry.mode = next;
      apply(`${owner} set ${next}`);
    },
    release() {
      if (released) return;
      released = true;
      const index = requests.findIndex((r) => r.id === entry.id);
      if (index >= 0) requests.splice(index, 1);
      apply(`${owner} released`);
    },
  };
}

/**
 * What the rotate button asks for: the OTHER orientation from the one on screen - landscape from
 * portrait (even with the lock on), portrait from landscape (whether the phone or the button turned it).
 */
export function rotateTarget(landscapeNow: boolean): OrientationMode {
  return landscapeNow ? 'portrait' : 'landscape';
}

/**
 * A component's hold on the orientation, for its whole mount: requests `initial` (auto by default) when
 * the component mounts and releases it when it unmounts. Call during component initialisation.
 *
 * - `rotate()` is the rotate button: the other orientation from the one on screen, kept until the
 *   component unmounts (a second press is portrait, forced too - the lock-proof way back).
 * - `hold(true)` FREEZES the orientation on screen (`locked`): a camera take and a live on air are
 *   recorded at one frame size, so the screen may not turn under them - not on a tablet either, whose
 *   `portrait` is free rotation, and not by the 180-degree flip between the landscape sides that
 *   `landscape` allows; `hold(false)` gives the turn back.
 * - `canRotate` says whether to draw the button (the native app only).
 */
export function useScreenOrientation(owner: string, initial: OrientationMode = 'auto') {
  let request: OrientationRequest | null = null;
  /** `initial`, or the rotate button's last choice. */
  let chosen: OrientationMode = initial;
  /** Whether a take or a live froze what is on screen. */
  let frozen = false;
  const wanted = (): OrientationMode => (frozen ? 'locked' : chosen);
  $effect(() => {
    const held = requestOrientation(wanted(), owner);
    request = held;
    return () => {
      held.release();
      if (request === held) request = null;
    };
  });
  return {
    /** Turns to the other orientation (the rotate button). Ignored while frozen. */
    rotate(): void {
      if (frozen) return;
      chosen = rotateTarget(viewportOrientation.landscape);
      Log.i('ORIENTATION', `${owner}: the rotate button asks ${chosen}`);
      request?.set(chosen);
    },
    /** Freezes (true) or frees (false) the orientation on screen. Idempotent. */
    hold(on: boolean): void {
      if (on === frozen) return;
      frozen = on;
      Log.d('ORIENTATION', `${owner}: ${on ? 'held as it is on screen' : 'turn given back'}`);
      request?.set(wanted());
    },
    /** Whether the rotate button can do anything in this build. */
    get canRotate(): boolean {
      return orientationCanBeForced();
    },
  };
}

/**
 * Called ONCE per page load, from the root layout: native's orientation lives in the PROCESS, so a
 * reload or a WebContent kill while a screen held landscape would leave the app turned with no screen
 * owning it. The effective mode is posted whatever was last sent - that memory was the previous
 * page's - and it is portrait unless a screen of THIS page already asked (a child mounts before the
 * layout). Also starts the viewport's orientation reading. Returns its teardown.
 */
export function initScreenOrientation(): () => void {
  posted = null;
  apply('a page loaded');
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(orientation: landscape)');
  viewportOrientation.landscape = query.matches;
  const onChange = (event: MediaQueryListEvent) => {
    viewportOrientation.landscape = event.matches;
    Log.d('ORIENTATION', `viewport is now ${event.matches ? 'landscape' : 'portrait'}`);
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Test seam: forgets every request and what was posted. */
export function resetScreenOrientationForTest(): void {
  requests.length = 0;
  nextId = 1;
  posted = null;
  absenceSaid = false;
  viewportOrientation.landscape = false;
}
