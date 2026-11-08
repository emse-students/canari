import { appendLog } from '$lib/utils/sessionLog';
import { isIosTauriRuntime } from '$lib/utils/appVersion';
import { ScreenWakeLock } from '$lib/live/liveDevice';

/**
 * THE SCREEN STAYS ON DURING A VIDEO CALL ON THE iPHONE.
 *
 * WKWebView refuses the Screen Wake Lock API (`NotAllowedError: Permission was denied`, read on the
 * iPhone 12 on `1.6.7-alpha.3`, every video call), so the iOS app keeps the screen on natively:
 * `canari_ios.mm` registers the `canariIdleTimer` message handler, which sets
 * `UIApplication.idleTimerDisabled` from the boolean this module posts. Which path holds the screen
 * is decided by the PLATFORM, at the decision ({@link callScreenAwake}) - never by asking the engine
 * and classifying its refusal.
 *
 * Nothing outlives the process: `idleTimerDisabled` is a property of the running app, so a kill or
 * a crash gives the screen back to the system. A WebContent kill or a reload mid-call leaves the
 * PROCESS alive, which is why every page load posts `false` once
 * ({@link releaseIosIdleTimerOfPreviousPage}). iOS ignores the property while the app is not in the
 * foreground, so a call ended in the background is released when the page next runs its effects,
 * before the user can see the screen.
 */

/** What a call holds to keep the screen on: the engine's wake lock, or the iOS idle timer. */
export interface CallScreenAwake {
  /** Asks for the screen to stay on (again after a return to the foreground). Idempotent. */
  hold(): void | Promise<void>;
  /** Lets the screen sleep again. Idempotent. */
  release(): void;
}

/** The last value posted, so a hold repeated on every return to the screen posts nothing. */
let posted: boolean | null = null;

/** Tells the iOS shell to disable or re-enable the idle timer; logs every change with its cause. */
export function setIosIdleTimerDisabled(disabled: boolean, why: string): void {
  if (posted === disabled) return;
  const handler = (
    globalThis as unknown as {
      webkit?: { messageHandlers?: { canariIdleTimer?: { postMessage: (m: boolean) => void } } };
    }
  ).webkit?.messageHandlers?.canariIdleTimer;
  posted = disabled;
  if (!handler) {
    // Only an ASK that cannot be honoured is a defect; releasing nothing is not.
    if (disabled) {
      appendLog(
        `[CALL-WAKE] ERROR no canariIdleTimer handler in this iOS build - the screen may dim (${why})`
      );
    }
    return;
  }
  appendLog(`[CALL-WAKE] iOS idle timer ${disabled ? 'disabled' : 'enabled'} (${why})`);
  handler.postMessage(disabled);
}

/** The iOS holder: the idle timer, through {@link setIosIdleTimerDisabled}. */
const iosIdleTimerAwake: CallScreenAwake = {
  hold: () => setIosIdleTimerDisabled(true, 'a video call is on screen'),
  release: () => setIosIdleTimerDisabled(false, 'the video call left the screen'),
};

/**
 * The screen holder of a call, chosen by platform: the iOS app's idle timer, the engine's Screen
 * Wake Lock everywhere else (Android's WebView and the browsers grant it).
 */
export function callScreenAwake(ios: boolean = isIosTauriRuntime()): CallScreenAwake {
  return ios ? iosIdleTimerAwake : new ScreenWakeLock(undefined, 'CALL-WAKE');
}

/**
 * Called ONCE per page load on iOS - the twin of `releaseIosProximityOfPreviousPage`. A page that
 * has just loaded holds no call, but the idle timer lives in the PROCESS: a reload or a WebContent
 * kill mid-call would leave the screen on for good. Posted whatever this module last sent, since that
 * memory was the previous page's.
 */
export function releaseIosIdleTimerOfPreviousPage(): void {
  posted = null;
  setIosIdleTimerDisabled(false, 'a page loaded - no call holds the screen');
}

/** Test seam: forgets the last posted value. */
export function resetIosIdleTimerForTest(): void {
  posted = null;
}
